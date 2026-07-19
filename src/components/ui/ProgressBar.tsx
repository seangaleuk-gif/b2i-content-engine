interface ProgressBarProps {
  value: number;
  max?: number;
  size?: "sm" | "md";
  variant?: "primary" | "success" | "warning";
  className?: string;
}

const sizeClasses = {
  sm: "h-1",
  md: "h-1.5",
};

const variantClasses = {
  primary: "bg-accent-primary",
  success: "bg-accent-green",
  warning: "bg-accent-warning",
};

export function ProgressBar({
  value,
  max = 100,
  size = "md",
  variant = "primary",
  className = "",
}: ProgressBarProps) {
  const pct = Math.min(Math.max((value / max) * 100, 0), 100);

  return (
    <div
      className={`w-full bg-bg-surface-secondary rounded-full overflow-hidden ${sizeClasses[size]} ${className}`}
    >
      <div
        className={`h-full rounded-full transition-all duration-500 ${variantClasses[variant]}`}
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}
