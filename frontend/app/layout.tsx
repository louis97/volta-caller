import "./globals.css";

import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = {
  title: "Volta Dispatch",
  description: "Autonomous freight dispatch console"
};

/**
 * Applies the stored theme before first paint so the console never flashes the
 * wrong ground colour. With no stored choice the CSS falls back to the
 * operating system preference.
 */
const themeBootstrap = `try{var t=localStorage.getItem("volta-theme");if(t==="dark"||t==="light"){document.documentElement.dataset.theme=t}}catch(e){}`;

export default function RootLayout({
  children
}: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en">
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeBootstrap }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
