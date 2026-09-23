import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Solo desarrollo: Supabase local usa 127.0.0.1 y Next bloquea por defecto los recursos de dev
  // cuando el origen no es "localhost" (la página no cargaba su JavaScript).
  allowedDevOrigins: ["127.0.0.1"],
};

export default nextConfig;
