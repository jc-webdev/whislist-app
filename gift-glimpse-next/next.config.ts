import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Cała treść aplikacji renderuje się w kliencie (AppShell w layout.tsx),
  // żeby przetrwać nawigację między trasami bez przeładowania stanu i danych
  // z Supabase — realny SSR tu nic by nie dał, a tylko ten wskaźnik migał.
  devIndicators: false,
};

export default nextConfig;
