# Risco Stack (MQTT + Web + Modbus)

Gateway para paneles Risco LightSYS/LightSYS Plus que expone:
- MQTT (descubrimiento Home Assistant, estados de particiones y zonas, comandos).
- Dashboard web (armar/desarmar, bypass, estados en tiempo real).
- Modbus TCP (holding/discrete registers con estados y comandos).

## Estructura
- `docker-compose.yml` → orquesta mosquitto y la app.
- `mosquitto/` → configuración y datos de Mosquitto.
- `risco/`
  - `Dockerfile.risco` → build de la app.
  - `config.json` → configuración en runtime (montada en el contenedor).
  - `app/` → código de la app (TypeScript, web estático, server Modbus).
  - `risco-lan-bridge/` → librería local incluida en la build.

## Requisitos
- Docker / Docker Compose.
- Node 18+ si quieres compilar localmente (opcional).

## Puesta en marcha (local/Docker)
1. Desde la raíz del proyecto:  
   ```bash
   docker compose down
   docker compose build --no-cache risco
   docker compose up -d
   ```
2. Dashboard: http://localhost:8080/
3. MQTT broker: `mqtt://localhost:1883` (usuario/clave según tu `mosquitto.conf`).
4. Modbus TCP: puerto 502 (holding/discrete ya mapeados).

### Compilar la app localmente (opcional)
```bash
cd risco/app
npm install
npm run build
```

## Configuración clave (`risco/config.json`)
- `panel.*`: IP/puerto/credenciales del panel Risco.
- `mqtt.url`: broker (en compose se usa `mqtt://mosquitto:1883`).
- `web.enable/http_port/ws_path`: dashboard.
- `modbus.enable/port/host`: servidor Modbus TCP.
- No se versiona tu configuración sensible; mantenla fuera de Git o en un secret.

## Registro de estados (Modbus)
- Holding particiones regs 1–32 (uint16):  
  `0=disarmed, 1=armed(home/away), 2=triggered, 3=Ready, 4=NotReady`
- Holding zonas regs 33–544 (uint16):  
  `0=cerrada, 1=abierta, 2=bypass`
- Discrete inputs:  
  bits 0–31 particiones alarmadas (1)  
  bits 32–543 zonas abiertas (1)
- Escritura (holding):
  - Partición reg = 0/1/2 → desarmar/home/away.
  - Zona reg = 2/0 → aplicar/quitar bypass.

## Migrar a otro equipo
- Opción A (reconstruir): copiar repo y `config.json`, luego `docker compose build --no-cache risco && docker compose up -d`.
- Opción B (imagen empaquetada misma arquitectura):
  ```
  docker save -o risco_stack.tar risco_stack-risco:latest eclipse-mosquitto:2
  # en destino
  docker load -i risco_stack.tar
  docker compose up -d
  ```
- Para ARM/Raspberry: construir multi-arch con `docker buildx build --platform linux/arm/v7,linux/arm64,linux/amd64 ...` usando `Dockerfile.risco`.

## GitHub
- Inicializa el repo y sube:
  ```bash
  git init
  git add .
  git commit -m "Initial Risco stack"
  git remote add origin git@github.com:tu_usuario/risco_stack.git
  git push -u origin main
  ```
- Asegura que `config.json` con credenciales reales no se suba (usa plantillas o secrets).

## Licencia
- Mantén la licencia original de `@vanackej/risco-mqtt-local` y de cualquier dependencia incluida.
