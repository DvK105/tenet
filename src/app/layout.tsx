import type { Metadata } from "next";
import { Lexend } from "next/font/google";
import "./globals.css";

const mainFont = Lexend({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Tenet",
  description: "Render Blender files in the cloud",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="dark">
      <body
        className={`${mainFont.variable} antialiased`}
      >
        {children}
      </body>
    </html>
  );
}
