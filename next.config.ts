import type { NextConfig } from "next";

const dev = process.env.NODE_ENV !== "production";

const base = (o: { script?: string; img?: string; connect?: string; frame?: string; form?: string }) =>
  [
    "default-src 'self'",
    `script-src 'self' 'unsafe-inline'${dev ? " 'unsafe-eval'" : ""}${o.script ? " " + o.script : ""}`,
    "style-src 'self' 'unsafe-inline'",
    `img-src 'self' data: blob:${o.img ? " " + o.img : ""}`,
    "font-src 'self' data:",
    `connect-src 'self'${dev ? " ws: wss:" : ""}${o.connect ? " " + o.connect : ""}`,
    ...(o.frame ? [`frame-src ${o.frame}`] : []),
    "frame-ancestors 'none'",
    "base-uri 'self'",
    `form-action 'self'${o.form ? " " + o.form : ""}`,
    "object-src 'none'",
  ].join("; ");

const csp = base({});

/**
 * The customer payment page loads the provider checkout SDKs (Razorpay / Cashfree). Only /pay/* gets these
 * extra origins; everything else keeps the strict policy above.
 */
const payCsp = base({
  script: "https://checkout.razorpay.com https://sdk.cashfree.com",
  img: "https:",
  connect: "https://api.razorpay.com https://lumberjack.razorpay.com https://checkout.razorpay.com https://api.cashfree.com https://sandbox.cashfree.com https://payments.cashfree.com https://sdk.cashfree.com",
  frame: "https://api.razorpay.com https://checkout.razorpay.com https://sdk.cashfree.com https://payments.cashfree.com https://sandbox.cashfree.com https://*.cashfree.com",
  form: "https:",
});

const securityHeaders = (policy: string) => [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
  { key: "Content-Security-Policy", value: policy },
];

const config: NextConfig = {
  serverExternalPackages: ["pdfkit", "argon2", "pg", "nodemailer"],
  poweredByHeader: false,
  async headers() {
    return [
      { source: "/pay/:path*", headers: securityHeaders(payCsp) },
      { source: "/((?!pay/).*)", headers: securityHeaders(csp) },
    ];
  },
};

export default config;
