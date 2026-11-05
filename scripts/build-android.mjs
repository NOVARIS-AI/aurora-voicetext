import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const windows = process.platform === 'win32';
const npm = windows ? 'npm.cmd' : 'npm';
const npx = windows ? 'npx.cmd' : 'npx';

function run(command, args, cwd = process.cwd()) {
  const result = spawnSync(command, args, {
    cwd,
    stdio: 'inherit',
    shell: windows,
    env: process.env,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

const manifest = resolve('android/app/src/main/AndroidManifest.xml');
if (!existsSync(manifest)) {
  console.log('Android platform is not present yet. Creating the Capacitor Android project…');
  run(npx, ['cap', 'add', 'android']);
}

console.log('\nBuilding the web app…');
run(npm, ['run', 'build']);

console.log('\nSyncing the latest app into Android…');
run(npx, ['cap', 'sync', 'android']);

const wrapper = windows ? 'gradlew.bat' : './gradlew';
console.log('\nAssembling the Android debug APK…');
run(wrapper, ['assembleDebug'], resolve('android'));

console.log('\nAPK created at: android/app/build/outputs/apk/debug/app-debug.apk');
