import express from 'express';
import { Server as HttpServer } from 'http';
import { WebSocketServer } from 'ws';
import * as Modbus from 'jsmodbus';
import net from 'net';
import path from 'path';

type PartitionState = { id: number; status: string; ready?: boolean };
type ZoneState = { id: number; open: boolean; bypass: boolean; label: string };
type PanelState = { online: boolean };

export interface WebOptions {
  http_port: number;
  ws_path: string;
}
export interface ModbusOptions {
  enable: boolean;
  port: number;
  host: string;
}

export interface RealtimeState {
  partitions: Map<number, PartitionState>;
  zones: Map<number, ZoneState>;
  panel?: PanelState;
}

const PARTITION_REGS = 32; // 32 particiones
const ZONE_REGS = 512;     // 512 zonas
const BYTES_PER_REG = 2;

export function startWebServer(
  web: WebOptions,
  modbus: ModbusOptions,
  state: RealtimeState,
  onArm: (partitionId: number, mode: 'away' | 'home' | 'disarm') => Promise<boolean>,
  onBypass?: (zoneId: number) => Promise<boolean>,
) {
  const app = express();
  const httpServer = new HttpServer(app);
  const panelState: PanelState = state.panel || { online: false };

  // Static dashboard
  const publicDir = path.join(process.cwd(), 'public');
  console.log(`[WEB] Static dir: ${publicDir}`);
  app.use(express.static(publicDir));

  // HTTP
  app.get('/health', (_req, res) => res.json({ ok: true }));
  app.get('/snapshot', (_req, res) => {
    res.json({
      panelOnline: panelState.online,
      partitions: Array.from(state.partitions.values()),
      zones: Array.from(state.zones.values()),
    });
  });

  // WebSocket
  const wss = new WebSocketServer({ server: httpServer, path: web.ws_path });
  const broadcast = (msg: any) => {
    const data = JSON.stringify(msg);
    wss.clients.forEach((c) => {
      if (c.readyState === c.OPEN) c.send(data);
    });
  };

  wss.on('connection', (ws) => {
    ws.send(JSON.stringify({
      type: 'snapshot',
      panelOnline: panelState.online,
      partitions: Array.from(state.partitions.values()),
      zones: Array.from(state.zones.values()),
    }));
    ws.on('message', async (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'arm' && msg.partitionId && msg.mode) {
          const ok = await onArm(Number(msg.partitionId), msg.mode);
          const message = ok ? '' : (panelState.online ? 'Operación rechazada' : 'Panel offline');
          ws.send(JSON.stringify({ type: 'ack', action: 'arm', ok, partitionId: Number(msg.partitionId), message }));
        } else if (msg.type === 'bypass' && msg.zoneId && onBypass) {
          const ok = await onBypass(Number(msg.zoneId));
          const message = ok ? '' : (panelState.online ? 'Operación rechazada' : 'Panel offline');
          ws.send(JSON.stringify({ type: 'ack', action: 'bypass', ok, zoneId: Number(msg.zoneId), message }));
        }
      } catch (e) {
        ws.send(JSON.stringify({ type: 'ack', ok: false, message: (e as Error).message || 'Error' }));
      }
    });
  });

  // Fallback to dashboard
  app.get('*', (_req, res) => {
    res.sendFile(path.join(publicDir, 'index.html'));
  });

  httpServer.listen(web.http_port, () => {
    console.log(`[WEB] HTTP/WS listening on ${web.http_port}${web.ws_path}`);
  });

  // Modbus TCP (jsmodbus ModbusTCPServer expects net.Server como primer argumento)
  if (modbus.enable) {
    const totalRegs = PARTITION_REGS + ZONE_REGS;
    const holding = Buffer.alloc(totalRegs * BYTES_PER_REG);
    const discrete = Buffer.alloc(Math.ceil((PARTITION_REGS + ZONE_REGS) / 8));

    const bitSet = (buf: Buffer, index: number, value: boolean) => {
      const byte = Math.floor(index / 8);
      const bit = index % 8;
      const cur = buf.readUInt8(byte);
      const next = value ? cur | (1 << bit) : cur & ~(1 << bit);
      buf.writeUInt8(next, byte);
    };

    const writePartition = (p: PartitionState) => {
      if (p.id >= 1 && p.id <= PARTITION_REGS) {
        holding.writeUInt16BE(encodePartitionHolding(p.status, p.ready), (p.id - 1) * BYTES_PER_REG);
        const alarm = p.status === 'triggered';
        bitSet(discrete, p.id - 1, alarm);
      }
    };
    const writeZone = (z: ZoneState) => {
      if (z.id >= 1 && z.id <= ZONE_REGS) {
        const regIdx = PARTITION_REGS + z.id - 1;
        holding.writeUInt16BE(encodeZoneHolding(z.open, z.bypass), regIdx * BYTES_PER_REG);
        bitSet(discrete, regIdx, z.open);
      }
    };

    state.partitions.forEach((p) => writePartition(p));
    state.zones.forEach((z) => writeZone(z));

    const modbusNetServer = net.createServer();
    const modbusServer = new (Modbus as any).ModbusTCPServer(modbusNetServer, { holding, discrete });
    modbusServer.on('connection', () => console.log('[MODBUS] client connected'));

    const handleWriteRegisters = async (startAddress: number, values: number[]) => {
      for (let i = 0; i < values.length; i++) {
        const regIndex = startAddress + i; // base 0
        const val = values[i];
        if (regIndex < PARTITION_REGS) {
          const partitionId = regIndex + 1;
          // Solo permitimos 0=disarm, 1=arm away (full). Ignoramos 2 (home) para este proyecto.
          if (val === 0 || val === 1) {
            const mode: 'disarm' | 'home' | 'away' = val === 0 ? 'disarm' : 'away';
            const ok = await onArm(partitionId, mode);
            const current = state.partitions.get(partitionId);
            if (!ok && current) writePartition(current);
          }
        } else if (regIndex < PARTITION_REGS + ZONE_REGS) {
          const zoneId = regIndex - PARTITION_REGS + 1;
          if (val === 0 || val === 2) {
            const desiredBypass = val === 2;
            const current = state.zones.get(zoneId)?.bypass ?? false;
            if (desiredBypass !== current && onBypass) {
              const ok = await onBypass(zoneId);
              const zone = state.zones.get(zoneId);
              if (!ok && zone) writeZone(zone);
            }
          }
        }
      }
    };

    modbusServer.on('postWriteSingleRegister', async (req: any) => {
      const value = req.body.value;
      await handleWriteRegisters(req.body.address, [value]);
    });
    modbusServer.on('postWriteMultipleRegisters', async (req: any) => {
      const vals: number[] = [];
      for (let i = 0; i < req.body.values.length; i += 2) {
        vals.push(req.body.values.readUInt16BE(i));
      }
      await handleWriteRegisters(req.body.address, vals);
    });

    modbusNetServer.listen(modbus.port, modbus.host, () => {
      console.log(`[MODBUS] TCP listening on ${modbus.host}:${modbus.port}`);
    });

    return {
      broadcast,
      updatePartition: (p: PartitionState) => {
        state.partitions.set(p.id, p);
        writePartition(p);
        broadcast({ type: 'partition', data: p });
      },
      updateZone: (z: ZoneState) => {
        state.zones.set(z.id, z);
        writeZone(z);
        broadcast({ type: 'zone', data: z });
      },
      updatePanelStatus: (online: boolean) => {
        panelState.online = online;
        broadcast({ type: 'panel', online });
      },
      stop: () => {
        wss.clients.forEach((c) => c.terminate());
        wss.close();
        httpServer.close();
        modbusNetServer.close();
      },
    };
  }

  // Sin Modbus
  return {
    broadcast,
    updatePartition: (p: PartitionState) => {
      state.partitions.set(p.id, p);
      broadcast({ type: 'partition', data: p });
    },
    updateZone: (z: ZoneState) => {
      state.zones.set(z.id, z);
      broadcast({ type: 'zone', data: z });
    },
    updatePanelStatus: (online: boolean) => {
      panelState.online = online;
      broadcast({ type: 'panel', online });
    },
    stop: () => {
      wss.clients.forEach((c) => c.terminate());
      wss.close();
      httpServer.close();
    },
  };
}

// codifica estado de partición en holding register
function encodePartition(status: string): number {
  switch (status) {
    case 'armed_away': return 2;
    case 'armed_home': return 1;
    case 'triggered': return 3;
    case 'disarmed':
    default: return 0;
  }
}

// Holding register: 0=desarmada, 1=armada (home/away), 2=alarmada/triggered, 3=Ready (desarmada), 4=NotReady (desarmada)
function encodePartitionHolding(status: string, ready?: boolean): number {
  if (status === 'triggered') return 2;
  if (ready === true) return 3;
  if (ready === false) return 4;
  if (status === 'armed_home' || status === 'armed_away') return 1;
  return 0;
}

// Holding zone: 0=cerrada/normal, 1=abierta/alarmada, 2=bypass
function encodeZoneHolding(open: boolean, bypass: boolean): number {
  if (bypass) return 2;
  return open ? 1 : 0;
}
