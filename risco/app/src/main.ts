#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
import { riscoMqttHomeAssistant } from './lib';

function maskConfig(raw: any) {
  const clone = JSON.parse(JSON.stringify(raw));
  if (clone?.panel?.panelPassword !== undefined) clone.panel.panelPassword = '***';
  if (clone?.panel?.panelPassword2 !== undefined) clone.panel.panelPassword2 = '***';
  if (clone?.mqtt?.password !== undefined) clone.mqtt.password = '***';
  return clone;
}

try {
  let configPath = "";
  if ("RISCO_MQTT_HA_CONFIG_FILE" in process.env) {
    // if this var is set, we know we are running in the addon
    configPath = process.env.RISCO_MQTT_HA_CONFIG_FILE;
    // check if is file
    const sampleConfigPath = path.join(__dirname, "../config-sample.json");
    if (!fs.existsSync(configPath) && fs.existsSync(sampleConfigPath)) {
      fs.copyFileSync(sampleConfigPath, configPath);
    }
  } else {
    configPath = path.join(process.cwd(), 'config.json');
  }
  console.log('Loading config from: ' + configPath);
  if (fs.existsSync(configPath)) {
    const config = require(configPath);
    console.debug('Config (masked): ' + JSON.stringify(maskConfig(config), null, 2));
    riscoMqttHomeAssistant(config);
  } else {
    console.error(`file ${configPath} does not exist`);
    process.exit(1);
  }
} catch (e) {
  console.error('Startup error', e);
  process.exit(1);
}
