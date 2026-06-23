import path from 'node:path';
import fs from 'node:fs';
import { defineConfig } from 'vite';
import dts from 'vite-plugin-dts';

const pkg = JSON.parse(fs.readFileSync(new URL('./package.json', import.meta.url), 'utf-8'));

export default defineConfig({
    plugins: [dts({ rollupTypes: false })],
    build: {
        lib: {
            entry: { index: path.resolve(__dirname, './src/index.ts') },
            name: 'max-pinia',
            fileName: (format, entryName) => `${entryName}.${format}.js`,
            formats: ['es']
        },
        rollupOptions: {
            external: [
                'vue',
                'pinia',
                ...Object.keys(pkg.dependencies || {}),
                ...Object.keys(pkg.peerDependencies || {})
            ],
            output: {
                exports: 'named',
                globals: { vue: 'Vue', pinia: 'Pinia' }
            }
        },
        sourcemap: true,
        minify: false
    },
    resolve: { alias: { '@': path.resolve(__dirname, './src') } }
});
