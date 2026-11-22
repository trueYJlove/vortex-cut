import { Clapperboard, Plus, X } from "lucide-react";
import type { Project } from "@aivideo/contracts";
import { useRef } from "react";

export function ProjectTabStrip({ projects, current, onSelect, onClose, onNew }: {
  projects: Project[];
  current?: Project;
  onSelect: (project: Project) => void;
  onClose: (project: Project) => void;
  onNew: () => void;
}) {
  const tabs = useRef<HTMLDivElement>(null);
  return <div className="project-tab-strip">
    <div ref={tabs} role="tablist" aria-label="已打开的项目" className="project-tab-list"
      onKeyDown={event => {
        const keys = ["ArrowLeft", "ArrowRight", "Home", "End"];
        if (!keys.includes(event.key) || (event.target as HTMLElement).getAttribute("role") !== "tab") return;
        const index = projects.findIndex(item => item.project_id === current?.project_id);
        const step = event.key === "ArrowLeft" ? -1 : 1;
        const next = event.key === "Home" ? 0 : event.key === "End" ? projects.length - 1 : (index + step + projects.length) % projects.length;
        if (!projects[next]) return;
        event.preventDefault();
        event.stopPropagation();
        onSelect(projects[next]);
        tabs.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus();
      }}>
      {projects.map(project => {
        const active = project.project_id === current?.project_id;
        return <div className="project-tab" data-active={active} key={project.project_id}>
          <button type="button" role="tab" aria-selected={active} tabIndex={active ? 0 : -1} title={project.name}
            onClick={() => onSelect(project)}><Clapperboard size={14} aria-hidden="true" /><span>{project.name}</span></button>
          {projects.length > 1 && <button type="button" className="project-tab-close" aria-label={`关闭项目标签 ${project.name}`}
            onClick={() => onClose(project)}><X size={12} aria-hidden="true" /></button>}
        </div>;
      })}
    </div>
    <button type="button" className="project-tab-add" aria-label="新建项目" title="新建项目"
      onClick={onNew}><Plus size={16} aria-hidden="true" /></button>
  </div>;
}
