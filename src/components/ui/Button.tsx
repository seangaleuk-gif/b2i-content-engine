import { forwardRef } from "react";
import { Loader2 } from "lucide-react";

type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
type ButtonSize = "sm" | "md" | "lg";

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  icon?: React.ReactNode;
}

const variantClasses: Record<ButtonVariant, string> = {
  primary:
    "bg-accent-primary text-white hover:bg-accent-primary-hover border-transparent",
  secondary:
    "bg-bg-surface-secondary text-text-primary hover:bg-[#2d3a50] border-border-subtle",
  ghost:
    "bg-transparent text-text-secondary hover:text-text-primary hover:bg-[rgba(255,255,255,0.04)] border-transparent",
  danger:
    "bg-accent-danger/10 text-accent-danger hover:bg-accent-danger/20 border-accent-danger/20",
};

const sizeClasses: Record<ButtonSize, string> = {
  sm: "px-3 py-1.5 text-[13px] rounded-lg gap-1.5",
  md: "px-4 py-2 text-[14px] rounded-[10px] gap-2",
  lg: "px-5 py-2.5 text-[15px] rounded-[12px] gap-2",
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  (
    {
      variant = "primary",
      size = "md",
      loading = false,
      icon,
      children,
      className = "",
      disabled,
      ...props
    },
    ref
  ) => {
    return (
      <button
        ref={ref}
        disabled={disabled || loading}
        className={`inline-flex items-center justify-center font-medium border transition-all duration-150 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed ${variantClasses[variant]} ${sizeClasses[size]} ${className}`}
        {...props}
      >
        {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : icon}
        {children}
      </button>
    );
  }
);

Button.displayName = "Button";
