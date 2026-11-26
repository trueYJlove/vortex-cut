import type { MutableRefObject, RefObject } from "react";
import { ChevronDown, ChevronRight, Search, type LucideIcon } from "lucide-react";
import type { Project } from "@aivideo/contracts";
import { ProjectTabStrip } from "../workspace/ProjectTabStrip.js";

export type MenuEntry =
  | { label: string; icon?: LucideIcon; action: () => void; disabled?: boolean }
  | { divider: true }
  | { group: string };

const isMenuDivider = (entry: MenuEntry): entry is { divider: true } => "divider" in entry;
const isMenuGroup = (entry: MenuEntry): entry is { group: string } => "group" in entry;

export interface EditorTitlebarProps {
  project: Project | undefined;
  projects: Project[];
  openProjects: Project[];
  switchProject: (selected: Project) => void;
  closeProjectTab: (selected: Project) => void;
  onOpenProjectDialog: () => void;
  activeMenu: string | null;
  setActiveMenu: (menu: string | null) => void;
  appMenuTriggerRef: RefObject<HTMLButtonElement | null>;
  appMenuCategoryRefs: MutableRefObject<(HTMLButtonElement | null)[]>;
  appMenuPopoverRef: RefObject<HTMLDivElement | null>;
  menuItems: Record<string, MenuEntry[]>;
  menuShortcut: (label: string) => string | undefined;
  projectSwitcherOpen: boolean;
  setProjectSwitcherOpen: (open: boolean) => void;
  projectSwitcherQuery: string;
  setProjectSwitcherQuery: (query: string) => void;
  projectSwitcherRef: RefObject<HTMLDivElement | null>;
}

export function EditorTitlebar({
  project,
  projects,
  openProjects,
  switchProject,
  closeProjectTab,
  onOpenProjectDialog,
  activeMenu,
  setActiveMenu,
  appMenuTriggerRef,
  appMenuCategoryRefs,
  appMenuPopoverRef,
  menuItems,
  menuShortcut,
  projectSwitcherOpen,
  setProjectSwitcherOpen,
  projectSwitcherQuery,
  setProjectSwitcherQuery,
  projectSwitcherRef,
}: EditorTitlebarProps) {
  const menuCategories = Object.keys(menuItems);

  const openBrandMenu = () => {
    if (activeMenu) {
      setActiveMenu(null);
      return;
    }
    setActiveMenu(menuCategories[0] ?? null);
    requestAnimationFrame(() => appMenuCategoryRefs.current[0]?.focus({ preventScroll: true }));
  };

  const handleMenuCategoryKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const index = Math.max(0, menuCategories.indexOf(activeMenu ?? menuCategories[0] ?? ""));
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      setActiveMenu(null);
      appMenuTriggerRef.current?.focus({ preventScroll: true });
    } else if (["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) {
      event.preventDefault();
      event.stopPropagation();
      const next = event.key === "Home" ? 0 : event.key === "End" ? menuCategories.length - 1
        : (index + (event.key === "ArrowDown" ? 1 : -1) + menuCategories.length) % menuCategories.length;
      setActiveMenu(menuCategories[next]);
      requestAnimationFrame(() => appMenuCategoryRefs.current[next]?.focus({ preventScroll: true }));
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      event.stopPropagation();
      appMenuPopoverRef.current?.querySelector<HTMLButtonElement>("[role='tabpanel'] [role='menuitem']:not(:disabled)")?.focus({ preventScroll: true });
    }
  };

  const handleMenuActionsKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const actions = Array.from(appMenuPopoverRef.current?.querySelectorAll<HTMLButtonElement>("[role='tabpanel'] [role='menuitem']:not(:disabled)") ?? []);
    const current = actions.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      setActiveMenu(null);
      appMenuTriggerRef.current?.focus({ preventScroll: true });
    } else if (event.key === "ArrowLeft") {
      event.preventDefault();
      event.stopPropagation();
      appMenuCategoryRefs.current[menuCategories.indexOf(activeMenu ?? "")]?.focus({ preventScroll: true });
    } else if (["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key) && actions.length) {
      event.preventDefault();
      event.stopPropagation();
      const next = event.key === "Home" ? 0 : event.key === "End" ? actions.length - 1
        : (Math.max(0, current) + (event.key === "ArrowDown" ? 1 : -1) + actions.length) % actions.length;
      actions[next]?.focus({ preventScroll: true });
    }
  };

  const filteredProjects = projectSwitcherQuery.trim()
    ? projects.filter(item => item.name.toLowerCase().includes(projectSwitcherQuery.trim().toLowerCase()))
    : projects;

  return (
    <div className="editor-titlebar">
      <div className="custom-titlebar-drag">
        <div className="brand-lockup" title="Vortex Cut">
          <div className="brand-menu-anchor">
            <button
              ref={appMenuTriggerRef}
              type="button"
              className="brand-menu-trigger"
              aria-label="Vortex Cut 主菜单"
              aria-haspopup="dialog"
              aria-expanded={Boolean(activeMenu)}
              aria-controls={activeMenu ? "brand-menu-popover" : undefined}
              title="主菜单"
              onClick={event => { event.stopPropagation(); openBrandMenu(); }}
            >
              <span className="brand-mark"><img src="./icons/256.png" alt="" /></span>
            </button>
            {activeMenu && (
              <div
                ref={appMenuPopoverRef}
                id="brand-menu-popover"
                className="brand-menu-popover"
                role="dialog"
                aria-label="Vortex Cut 主菜单"
                onClick={event => event.stopPropagation()}
                onBlur={event => {
                  const next = event.relatedTarget as Node | null;
                  if (next && !appMenuPopoverRef.current?.contains(next) && !appMenuTriggerRef.current?.contains(next)) setActiveMenu(null);
                }}
              >
                <div className="brand-menu-categories" role="tablist" aria-label="主菜单分类" onKeyDown={handleMenuCategoryKeyDown}>
                  {menuCategories.map((menu, menuPosition) => (
                    <button
                      ref={element => { appMenuCategoryRefs.current[menuPosition] = element; }}
                      key={menu}
                      type="button"
                      role="tab"
                      id={`brand-menu-tab-${menu}`}
                      aria-selected={activeMenu === menu}
                      aria-controls="brand-menu-actions"
                      tabIndex={activeMenu === menu ? 0 : -1}
                      className={activeMenu === menu ? "active" : ""}
                      onMouseEnter={() => setActiveMenu(menu)}
                      onClick={() => setActiveMenu(menu)}
                    >
                      {menu}<ChevronRight size={13} aria-hidden="true" />
                    </button>
                  ))}
                </div>
                <section className="brand-menu-content" role="tabpanel" id="brand-menu-actions" aria-labelledby={`brand-menu-tab-${activeMenu}`}>
                  <h2>{activeMenu}</h2>
                  <div className="menu-dropdown brand-menu-actions" role="menu" aria-label={`${activeMenu}菜单`} onKeyDown={handleMenuActionsKeyDown}>
                    {menuItems[activeMenu].map((item, entryIndex) => {
                      if (isMenuDivider(item)) return <div key={`divider-${entryIndex}`} className="menu-divider" role="separator" />;
                      if (isMenuGroup(item)) return <div key={`group-${entryIndex}`} className="menu-group-label">{item.group}</div>;
                      return (
                        <button
                          key={item.label}
                          type="button"
                          role="menuitem"
                          disabled={item.disabled}
                          onClick={() => { item.action(); setActiveMenu(null); }}
                        >
                          <span className="menu-item-ico">{item.icon && <item.icon size={14} aria-hidden="true" />}</span>
                          <span className="menu-item-label">{item.label}</span>
                          {menuShortcut(item.label) && <kbd className="menu-item-shortcut">{menuShortcut(item.label)}</kbd>}
                        </button>
                      );
                    })}
                  </div>
                </section>
              </div>
            )}
          </div>
          <strong>Vortex Cut</strong>
        </div>
        <ProjectTabStrip
          projects={openProjects}
          current={project}
          onSelect={switchProject}
          onClose={closeProjectTab}
          onNew={onOpenProjectDialog}
        />
      </div>
      <div className="titlebar-project-switcher" ref={projectSwitcherRef}>
        <button
          className="titlebar-project-switcher-toggle"
          aria-label="切换项目"
          aria-haspopup="listbox"
          aria-expanded={projectSwitcherOpen}
          onClick={event => {
            event.stopPropagation();
            const next = !projectSwitcherOpen;
            setProjectSwitcherOpen(next);
            if (!next) setProjectSwitcherQuery("");
          }}
        >
          {project && <span className={`pdot ${project.status === "active" ? "active" : project.status === "archived" ? "archived" : "missing"}`} />}
          <span className="titlebar-project-name">{project?.name ?? "未选择项目"}</span>
          {project && <span className="project-switcher-state">{project.status === "active" ? "活跃" : project.status === "archived" ? "已归档" : "目录缺失"}</span>}
          <ChevronDown className="titlebar-switcher-chevron" size={11} />
        </button>
        {projectSwitcherOpen && (
          <div className="project-switcher-dropdown" role="listbox" aria-label="选择项目">
            <div className="project-switcher-head">切换项目<small>本机项目</small></div>
            <label className="project-switcher-search" onClick={event => event.stopPropagation()}>
              <Search size={13} />
              <input value={projectSwitcherQuery} onChange={event => setProjectSwitcherQuery(event.target.value)} placeholder="搜索项目名…" />
            </label>
            {filteredProjects.map(item => (
              <button
                key={item.project_id}
                role="option"
                aria-selected={item.project_id === project?.project_id}
                className={item.project_id === project?.project_id ? "active" : ""}
                onClick={event => {
                  event.stopPropagation();
                  if (item.project_id !== project?.project_id) switchProject(item);
                  setProjectSwitcherOpen(false);
                  setProjectSwitcherQuery("");
                }}
              >
                <span className={`pdot ${item.status === "active" ? "active" : item.status === "archived" ? "archived" : "missing"}`} />
                <span className="project-switcher-name">{item.name}</span>
                <span className="project-switcher-state">{item.status === "active" ? "活跃" : item.status === "archived" ? "已归档" : "目录缺失"}</span>
              </button>
            ))}
            {!filteredProjects.length && <div className="project-switcher-none">没有匹配的项目</div>}
            {!projects.length && <div className="project-switcher-empty">尚无项目，请先创建</div>}
            <div className="project-switcher-actions">
              <button
                role="menuitem"
                className="project-switcher-manage"
                onClick={event => {
                  event.stopPropagation();
                  setProjectSwitcherOpen(false);
                  setProjectSwitcherQuery("");
                  onOpenProjectDialog();
                }}
              >
                项目管理
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
