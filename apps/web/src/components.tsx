import type { ReactNode } from "react";
import { LoaderCircle } from "lucide-react";

export function Card({ title, subtitle, action, children, className = "" }: { title?: string; subtitle?: string; action?: ReactNode; children: ReactNode; className?: string }) {
  return <section className={`card ${className}`}>
    {(title || action) && <header className="card-header"><div><h3>{title}</h3>{subtitle && <p>{subtitle}</p>}</div>{action}</header>}
    {children}
  </section>;
}

export function Button({ children, tone = "default", busy, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { tone?: "default" | "primary" | "danger"; busy?: boolean }) {
  return <button className={`button ${tone}`} disabled={busy || props.disabled} {...props}>{busy ? <LoaderCircle className="spin" size={16} /> : children}</button>;
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return <label className="field"><span>{label}</span>{children}{hint && <small>{hint}</small>}</label>;
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}

export function Pill({ children, tone = "neutral" }: { children: ReactNode; tone?: "neutral" | "good" | "warn" | "bad" }) {
  return <span className={`pill ${tone}`}>{children}</span>;
}
