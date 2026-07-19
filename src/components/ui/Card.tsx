interface CardProps {
  children: React.ReactNode;
  className?: string;
  hover?: boolean;
  padding?: "none" | "sm" | "md" | "lg";
}

const paddingClasses = {
  none: "",
  sm: "p-4",
  md: "p-5",
  lg: "p-6",
};

export function Card({
  children,
  className = "",
  hover = false,
  padding = "md",
}: CardProps) {
  return (
    <div
      className={`bg-bg-surface border border-border-subtle rounded-[12px] ${paddingClasses[padding]} ${
        hover
          ? "hover:border-[rgba(255,255,255,0.1)] hover:bg-[#161e30] transition-all duration-150 cursor-pointer"
          : ""
      } ${className}`}
    >
      {children}
    </div>
  );
}
