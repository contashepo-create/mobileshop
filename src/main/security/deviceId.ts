/**
 * The stable identity of this installation.
 *
 * Extracted from `license.handlers.ts` so that anything needing the device id
 * does not have to import the whole licence module. That module pulls in
 * Electron's `app`, the database and the remote store; password recovery needs
 * one string, and importing a licence screen to get it made every test that
 * touches users load the licence stack too.
 *
 * There is exactly ONE derivation, here, deliberately: a second copy that
 * hashed the same inputs in a slightly different order would silently issue
 * reset codes bound to an identity the licence does not recognise.
 */
import { app } from 'electron';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const SECRET_KEY = 'm0b1l3_sh0p_3rp_s3cr3t_k3y_2026_z3r0c0ld';
const DEVICE_FILE = 'device.id';

/**
 * Returns the device id, creating it on first run.
 *
 * Derived from MAC + CPU model + hostname so it survives a reinstall of the
 * application but changes if the machine really is a different one. The file is
 * then made read-only: the value must not drift once a licence is bound to it.
 */
export function getDeviceId(): string {
  const devicePath = path.join(app.getPath('userData'), DEVICE_FILE);
  if (fs.existsSync(devicePath)) {
    return fs.readFileSync(devicePath, 'utf-8');
  }
  const mac = Object.values(os.networkInterfaces()).flat()
    .find(i => i && !i.internal && i.mac !== '00:00:00:00:00:00')?.mac || 'unknown';
  const cpu = os.cpus()[0]?.model || 'unknown';
  const hostname = os.hostname();
  const rawId = `${mac}_${cpu}_${hostname}`;
  const deviceId = crypto.createHash('sha256').update(rawId + SECRET_KEY).digest('hex').substring(0, 32);
  fs.writeFileSync(devicePath, deviceId, 'utf-8');
  fs.chmodSync(devicePath, 0o444); // Read-only
  return deviceId;
}
