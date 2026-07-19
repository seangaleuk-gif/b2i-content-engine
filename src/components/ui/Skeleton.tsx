interface SkeletonProps {
  className?: string;
  variant?: "text" | "circular" | "rectangular";
  width?: string | number;
  height?: string | number;
}

export function Skeleton({
  className = "",
  variant = "text",
  width,
  height,
}: SkeletonProps) {
  const baseClasses = "animate-pulse bg-bg-surface-secondary rounded-[8px]";

  const variantClasses = {
    text: "h-4 rounded-[4px]",
    circular: "rounded-full",
    rectangular: "",
  };

  return (
    <div
      className={`${baseClasses} ${variantClasses[variant]} ${className}`}
      style={{ width, height }}
    />
  );
}
