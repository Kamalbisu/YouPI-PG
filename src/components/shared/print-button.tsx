"use client";
import { Printer } from "lucide-react";
import { Button } from "@/components/ui";

export function PrintButton() {
  return <Button variant="outline" onClick={() => window.print()}><Printer className="size-4" />Print</Button>;
}
