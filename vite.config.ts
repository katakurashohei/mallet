import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// base: './' so the build can be dropped into any sub-path of a website
export default defineConfig({
  base: './',
  plugins: [react()],
});
