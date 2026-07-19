type BadgeVariant =
  | "draft"
  | "published"
  | "research"
  | "images"
  | "translation"
  | "neutral"
  | "success"
  | "warning"
  | "danger";

interface BadgeProps {
  variant?: BadgeVariant;
  children: React.ReactNode;
  className?: string;
}

const variantClasses: Record<BadgeVariant, string> = {
  draft: "bg-[#4F7DF7]/15 text-[#4F7DF7] border-[#4F7DF7]/20",
  published: "bg-[#22C55E]/15 text-[#22C55E] border-[#22C55E]/20",
  research: "bg-[#F59E0B]/15 text-[#F59E0B] border-[#F59E0B]/20",
  images: "bg-[#A855F7]/15 text-[#A855F7] border-[#A855F7]/20",
  translation: "bg-[#EC4899]/15 text-[#EC4899] border-[#EC4899]/20",
  neutral: "bg-[#64748B]/15 text-[#94A3B8] border-[#64748B]/20",
  success: "bg-[#22C55E]/15 text-[#22C55E] border-[#22C55E]/20",
  warning: "bg-[#F59E0B]/15 text-[#F59E0B] border-[#F59E0B]/20",
  danger: "bg-[#EF4444]/15 text-[#EF4444] border-[#EF4444]/20",
};

export function Badge({
  variant = "neutral",
  children,
  className = "",
}: BadgeProps) {
  return (
    <span
      className={`inline-flex items-center px-2.5 py-0.5 text-[12px] font-medium rounded-full border ${variantClasses[variant]} ${className}`}
    >
      {children}
    </span>
  );
}
