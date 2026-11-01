import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.novaris.auroravoicetext',
  appName: 'AURORA VoiceText',
  webDir: 'dist',
  server: {
    androidScheme: 'https',
  },
};

export default config;
