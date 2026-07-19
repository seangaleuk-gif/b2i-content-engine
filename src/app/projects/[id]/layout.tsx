import { WorkflowStepper } from "./WorkflowStepper";

export default function ProjectLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="flex h-full">
      <WorkflowStepper />
      <div className="flex-1 overflow-y-auto">{children}</div>
    </div>
  );
}
