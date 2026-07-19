"use client";

import { FileText } from "lucide-react";
import { Button } from "./Button";

interface EmptyStateProps {
  icon?: React.ReactNode;
  title: string;
  description: string;
  actionLabel?: string;
  onAction?: () => void;
}

export function EmptyState({
  icon,
  title,
  description,
  actionLabel,
  onAction,
}: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center justify-center py-20 text-center">
      <div className="text-text-secondary/30 mb-4">
        {icon ?? <FileText size={48} />}
      </div>
      <h2 className="text-[20px] font-semibold text-text-primary mb-2">
        {title}
      </h2>
      <p className="text-[14px] text-text-secondary mb-6 max-w-md">
        {description}
      </p>
      {actionLabel && onAction && (
        <Button onClick={onAction}>{actionLabel}</Button>
      )}
    </div>
  );
}
