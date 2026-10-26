"use client";
import { useState } from "react";
import { Check, Copy } from "lucide-react";
import { Alert, Button } from "@/components/ui";

/** Shows a one-time set-password link to the admin. Rendered only from the API response; never persisted. */
export function InviteLinkBox({ link, emailStatus, purpose }: { link: string; emailStatus: string; purpose: "INVITE" | "PASSWORD_RESET" }) {
  const [copied, setCopied] = useState(false);
  const emailed = emailStatus === "SENT";
  return (
    <div className="space-y-3">
      <Alert tone={emailed ? "success" : "warn"}>
        {emailed
          ? "An email with the link was sent. You can also share the link below."
          : "Email is not configured or could not be sent. Share this link with the user yourself."}
      </Alert>
      <div className="space-y-1.5">
        <p className="text-sm font-medium text-ink">{purpose === "INVITE" ? "Set-password link" : "Password reset link"}</p>
        <div className="flex items-center gap-2">
          <input readOnly aria-label="One-time link" value={link} onFocus={(e) => e.currentTarget.select()} className="h-10 min-w-0 flex-1 rounded-lg border border-line bg-surface-muted px-3 font-mono text-xs" />
          <Button
            variant="outline"
            onClick={async () => {
              try { await navigator.clipboard.writeText(link); setCopied(true); setTimeout(() => setCopied(false), 2000); } catch { /* user can select the text */ }
            }}
          >
            {copied ? <Check className="size-4" /> : <Copy className="size-4" />}{copied ? "Copied" : "Copy"}
          </Button>
        </div>
        <p className="text-xs text-ink-muted">This link can be used once and is shown only now. It is not stored anywhere you can view later.</p>
      </div>
    </div>
  );
}
