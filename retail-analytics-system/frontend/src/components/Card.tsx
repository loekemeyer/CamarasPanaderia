import type { ReactNode } from "react";

interface CardProps {
  title?: string;
  subtitle?: ReactNode;
  actions?: ReactNode;
  className?: string;
  bodyClassName?: string;
  children: ReactNode;
}

export function Card({ title, subtitle, actions, className = "", bodyClassName = "", children }: CardProps) {
  return (
    <section className={`card flex h-full flex-col ${className}`}>
      {(title || actions) && (
        <header className="flex items-start justify-between gap-3 px-5 pt-4">
          <div className="min-w-0">
            {title && <h2 className="card-title">{title}</h2>}
            {subtitle && <p className="card-sub mt-0.5">{subtitle}</p>}
          </div>
          {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
        </header>
      )}
      <div className={`flex-1 px-5 pb-5 pt-3 ${bodyClassName}`}>{children}</div>
    </section>
  );
}
