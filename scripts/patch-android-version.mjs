import { readFileSync, writeFileSync } from 'node:fs';

const gradlePath = 'android/app/build.gradle';
const source = readFileSync(gradlePath, 'utf8');
const runNumber = Number(process.env.GITHUB_RUN_NUMBER);
const expectedApplicationId = 'com.novaris.auroravoicetext';

if (!Number.isSafeInteger(runNumber) || runNumber < 1) {
  throw new Error('GITHUB_RUN_NUMBER is missing or invalid.');
}

if (!source.includes('applicationId "' + expectedApplicationId + '"') &&
    !source.includes("applicationId '" + expectedApplicationId + "'")) {
  throw new Error('Generated Android applicationId does not match ' + expectedApplicationId + '.');
}

const versionCode = 1000 + runNumber;
const versionName = '1.0.' + runNumber;
let updated = source.replace(/versionCode\s+\d+/, 'versionCode ' + versionCode);
updated = updated.replace(/versionName\s+["'][^"']+["']/, 'versionName "' + versionName + '"');

if (updated === source || !/versionCode\s+\d+/.test(updated) || !/versionName\s+["'][^"']+["']/.test(updated)) {
  throw new Error('Could not safely update Android versionCode/versionName in ' + gradlePath);
}

writeFileSync(gradlePath, updated);
console.log('Android package: ' + expectedApplicationId);
console.log('Android versionCode: ' + versionCode);
console.log('Android versionName: ' + versionName);
