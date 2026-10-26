"use client";
import { forwardRef, useId, type InputHTMLAttributes, type SelectHTMLAttributes, type TextareaHTMLAttributes, type ReactNode } from "react";
import { cn } from "@/lib/utils";

const base =
  "w-full rounded-lg border border-line bg-surface px-3 text-sm text-ink placeholder:text-ink-muted/70 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/30 disabled:cursor-not-allowed disabled:opacity-60";

export function Field({
  label,
  error,
  hint,
  children,
  htmlFor,
}: {
  label: string;
  error?: string;
  hint?: string;
  children: ReactNode;
  htmlFor?: string;
}) {
  return (
    <div className="space-y-1.5">
      <label htmlFor={htmlFor} className="block text-sm font-medium text-ink">
        {label}
      </label>
      {children}
      {hint && !error && <p className="text-xs text-ink-muted">{hint}</p>}
      {error && (
        <p role="alert" className="text-xs text-red-600 dark:text-red-400">
          {error}
        </p>
      )}
    </div>
  );
}

interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label: string;
  error?: string;
  hint?: string;
}
export const Input = forwardRef<HTMLInputElement, InputProps>(function Input({ label, error, hint, className, id, ...rest }, ref) {
  const gen = useId();
  const fid = id ?? gen;
  return (
    <Field label={label} error={error} hint={hint} htmlFor={fid}>
      <input ref={ref} id={fid} aria-invalid={!!error} className={cn(base, "h-10", error && "border-red-500", className)} {...rest} />
    </Field>
  );
});

interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  label: string;
  error?: string;
  hint?: string;
}
export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea({ label, error, hint, className, id, ...rest }, ref) {
  const gen = useId();
  const fid = id ?? gen;
  return (
    <Field label={label} error={error} hint={hint} htmlFor={fid}>
      <textarea ref={ref} id={fid} rows={3} aria-invalid={!!error} className={cn(base, "py-2", error && "border-red-500", className)} {...rest} />
    </Field>
  );
});

interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  label: string;
  error?: string;
  hint?: string;
}
export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select({ label, error, hint, className, id, children, ...rest }, ref) {
  const gen = useId();
  const fid = id ?? gen;
  return (
    <Field label={label} error={error} hint={hint} htmlFor={fid}>
      <select ref={ref} id={fid} aria-invalid={!!error} className={cn(base, "h-10", error && "border-red-500", className)} {...rest}>
        {children}
      </select>
    </Field>
  );
});

/** Compact controls for filter bars (no label wrapper). */
export const FilterInput = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function FilterInput({ className, ...rest }, ref) {
  return <input ref={ref} className={cn(base, "h-9", className)} {...rest} />;
});
export const FilterSelect = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(function FilterSelect({ className, ...rest }, ref) {
  return <select ref={ref} className={cn(base, "h-9", className)} {...rest} />;
});

export function Checkbox({ label, hint, ...rest }: InputHTMLAttributes<HTMLInputElement> & { label: string; hint?: string }) {
  const id = useId();
  return (
    <div className="flex items-start gap-2.5">
      <input id={id} type="checkbox" className="mt-0.5 size-4 rounded border-line accent-brand-600" {...rest} />
      <label htmlFor={id} className="text-sm">
        <span className="font-medium text-ink">{label}</span>
        {hint && <span className="block text-xs text-ink-muted">{hint}</span>}
      </label>
    </div>
  );
}
