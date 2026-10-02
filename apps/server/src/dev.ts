// `npm run dev` entry: the development clock is on (the kiosk's `?now=18:40`).
process.env.PMP_DEV_CLOCK ??= '1';
await import('./index');

export {};
