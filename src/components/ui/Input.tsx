import { forwardRef } from "react";

interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  error?: string;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(
  ({ label, error, className = "", ...props }, ref) => {
    return (
      <div className="flex flex-col gap-1.5">
        {label && (
          <label className="text-[13px] font-medium text-text-secondary">
            {label}
          </label>
        )}
        <input
          ref={ref}
          className={`bg-bg-surface border border-border-subtle rounded-[10px] px-3.5 py-2.5 text-[14px] text-text-primary placeholder:text-text-secondary/50 focus:outline-none focus:border-accent-primary/50 focus:ring-1 focus:ring-accent-primary/20 transition-all duration-150 ${className}`}
          {...props}
        />
        {error && <p className="text-[12px] text-accent-danger">{error}</p>}
      </div>
    );
  }
);

Input.displayName = "Input";
