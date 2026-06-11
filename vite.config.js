import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import basicSsl from '@vitejs/plugin-basic-ssl';

// El modo "movil" activa HTTPS con certificado autofirmado, necesario para
// que el GPS del teléfono funcione al probar en red local (npm run dev:movil).
export default defineConfig(({ mode }) => ({
  plugins: [react(), ...(mode === 'movil' ? [basicSsl()] : [])],
  server: { host: true }
}));
