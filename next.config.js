/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  transpilePackages: ['three'],
  experimental: {
    optimizePackageImports: ['@react-three/drei', '@react-three/fiber'],
    // esbuild ships a native binary and uses a dynamic require, so webpack
    // can't bundle it into the serverless functions that import it
    // (lib/engine/codegen/staticcheck.ts). Keep it external — it's required
    // from node_modules at runtime instead of being bundled at build time.
    serverComponentsExternalPackages: ['esbuild'],
  },
};

module.exports = nextConfig;
