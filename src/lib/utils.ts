import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export const cn = (...inputs: ClassValue[]) => twMerge(clsx(inputs));

const dateFmt = new Intl.DateTimeFormat("en-IN", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Kolkata" });
const dayFmt = new Intl.DateTimeFormat("en-IN", { dateStyle: "medium", timeZone: "Asia/Kolkata" });

export const formatDateTime = (d: Date | string | null | undefined) => (d ? dateFmt.format(new Date(d)) : "-");
export const formatDate = (d: Date | string | null | undefined) => (d ? dayFmt.format(new Date(d)) : "-");
