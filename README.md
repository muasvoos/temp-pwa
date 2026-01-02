This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.

# Temp Monitor PWA (Supabase Live Dashboard)

A mobile-friendly PWA that shows live temperature readings from Supabase.
Designed to be “installed” on a phone via Add to Home Screen.

## Related project (Raspberry Pi uploader)
🌡️ Pi sensor uploader repo:  
- https://github.com/muasvoos/pi-temperature-monitor

## Architecture
Raspberry Pi (DS18B20) → Supabase `temperature_readings` → PWA (Realtime)

## Requirements
- Supabase project with table `temperature_readings`
- Realtime enabled for `temperature_readings`
- RLS policy that allows `SELECT` for the dashboard (or proper auth)

## Environment variables
Create `.env.local` in project root:
```env
NEXT_PUBLIC_SUPABASE_URL=https://<PROJECT>.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=<ANON_KEY>
NEXT_PUBLIC_DEVICE_ID=pi4
