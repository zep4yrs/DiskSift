import { useEffect, useRef, useState } from 'react';
import { Icon, type IconName } from './Icon';

// ── 顶带五菜单真下拉（26.1.4.0，审计单 §2-2「假菜单栏」处置）────────────
// 通用菜单条原语：菜单内容完全数据驱动（MenuDef[]），动作/灰显/复选语义由
// 调用方（App.tsx MENUS 数组）装配，本组件只管展开收起与键盘导航。
// 交互契约（规格 §6）：
// · 点击展开、Esc / 外点收起（window blur 一并收起，同 ContextMenu 纪律）；
// · ↑↓ 在可用项间循环移动焦点，Enter/空格原生触发按钮点击，←→ 相邻菜单切换；
// · 项高亮走 :focus-visible（全站 2px --ring 描边自动生效），不造假高亮；
// · 灰项必须 disabled + disabledReason 上 title，禁假可用。
// ARIA：nav role=menubar → 弹层 role=menu → 项 role=menuitem / menuitemcheckbox
// （复选标记随态，aria-checked 同步）。

export interface MenuItemDef {
  kind?: 'item';
  id: string;
  label: string;
  icon?: IconName;
  /** 复选标记（menuitemcheckbox）；undefined = 普通动作项（无检查列语义） */
  checked?: boolean;
  /** 灰显（禁假可用：必须配 disabledReason 供 title 说明） */
  disabled?: boolean;
  disabledReason?: string;
  /** 可用项的悬停说明（可选） */
  title?: string;
  run: () => void;
}

export interface MenuSeparatorDef {
  kind: 'separator';
}

export type MenuEntryDef = MenuItemDef | MenuSeparatorDef;

export interface MenuDef {
  id: string;
  label: string;
  items: MenuEntryDef[];
}

const isItem = (e: MenuEntryDef): e is MenuItemDef => e.kind !== 'separator';

export function MenuBar({ menus }: { menus: MenuDef[] }) {
  const [openId, setOpenId] = useState<string | null>(null);
  const navRef = useRef<HTMLElement | null>(null);

  const focusRootButton = (id: string) => {
    navRef.current
      ?.querySelector<HTMLButtonElement>(`[data-menu-root="${CSS.escape(id)}"]`)
      ?.focus();
  };

  const openMenu = (id: string) => {
    setOpenId(id);
  };
  const closeMenu = (refocus: string | null = null) => {
    setOpenId(null);
    if (refocus) focusRootButton(refocus);
  };

  // 外点 / 失焦收起（与 ContextMenu 同款纪律：mousedown 捕获 + blur）。
  // Esc 在弹层 onKeyDown 里处理（顺带把焦点还给它自己的根按钮）。
  useEffect(() => {
    if (!openId) return;
    const onDown = (e: MouseEvent) => {
      if (navRef.current && !navRef.current.contains(e.target as Node)) setOpenId(null);
    };
    const onBlur = () => setOpenId(null);
    window.addEventListener('mousedown', onDown, true);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('mousedown', onDown, true);
      window.removeEventListener('blur', onBlur);
    };
  }, [openId]);

  // 展开后把焦点落到位：首个【可用】项（灰项跳过——disabled 不可聚焦，
  // 这是「灰项不假装可用」在键盘侧的另一半）。高亮由 :focus-visible 全站规则给。
  // 探 bug 修复（全灰菜单键盘陷阱）：所有项都禁用时弹层内无处落焦，焦点必须
  // 留在根按钮上——落 body 会让 ↑↓/Enter/Esc 全部失联（弹层 onKeyDown 挂在
  // 弹层元素上，焦点不在里面就收不到），只剩鼠标外点一条路。留在根按钮上时
  // Esc（onRootKeyDown）/←→ 切换/外点收起全部照常可达。
  useEffect(() => {
    if (!openId) return;
    const first = navRef.current
      ?.querySelector<HTMLButtonElement>(`[data-menu-pop="${CSS.escape(openId)}"] .menu-item:not(:disabled)`);
    if (first) first.focus();
    else focusRootButton(openId);
  }, [openId]);

  // 弹层内键盘导航：↑↓ 循环（只走可用项）、Esc 收起还焦点、←→ 切相邻菜单、
  // Tab 直接放行（浏览器默认移走焦点，这里只负责收起弹层）。
  const onPopKeyDown = (e: React.KeyboardEvent, menu: MenuDef) => {
    const pop = e.currentTarget as HTMLElement;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      e.stopPropagation();
      const items = Array.from(pop.querySelectorAll<HTMLButtonElement>('.menu-item:not(:disabled)'));
      if (items.length === 0) return;
      const cur = items.indexOf(document.activeElement as HTMLButtonElement);
      const next = e.key === 'ArrowDown'
        ? items[(cur + 1 + items.length) % items.length]
        : items[(cur - 1 + items.length) % items.length];
      next?.focus();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      closeMenu(menu.id);
    } else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      e.preventDefault();
      e.stopPropagation();
      const idx = menus.findIndex((m) => m.id === menu.id);
      const delta = e.key === 'ArrowRight' ? 1 : -1;
      const next = menus[(idx + delta + menus.length) % menus.length];
      if (next) openMenu(next.id);
    } else if (e.key === 'Tab') {
      setOpenId(null);
    }
  };

  // 根按钮键盘：↓ 打开并聚焦首项；←→ 在根按钮间移动（收起态的菜单条导航）；
  // Esc 收起——探 bug 修复：全灰菜单展开时焦点留在根按钮（弹层 onKeyDown 收不到），
  // 这里是 Esc 的兜底分支，保证「Esc 外点收起」对任意菜单成立。
  const onRootKeyDown = (e: React.KeyboardEvent, menu: MenuDef) => {
    if (e.key === 'Escape') {
      if (openId === menu.id) {
        e.preventDefault();
        e.stopPropagation();
        closeMenu();
      }
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      openMenu(menu.id);
    } else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      const idx = menus.findIndex((m) => m.id === menu.id);
      const delta = e.key === 'ArrowRight' ? 1 : -1;
      const next = menus[(idx + delta + menus.length) % menus.length];
      if (next) {
        e.preventDefault();
        focusRootButton(next.id);
      }
    }
  };

  return (
    // className 沿用顶带既有 .menus（flex + gap），新增 .menubar 供菜单专属样式作用域
    <nav className="menus menubar" role="menubar" aria-label="主菜单" ref={navRef}>
      {menus.map((m) => {
        const open = openId === m.id;
        return (
          <div className="menu-anchor" key={m.id}>
            <button
              type="button"
              data-menu-root={m.id}
              className={'menu-root' + (open ? ' open' : '')}
              aria-haspopup="menu"
              aria-expanded={open}
              onClick={() => (open ? setOpenId(null) : openMenu(m.id))}
              onMouseEnter={() => { if (openId && openId !== m.id) openMenu(m.id); }}
              onKeyDown={(e) => onRootKeyDown(e, m)}
            >
              {m.label}
            </button>
            {open && (
              <div
                className="menu-pop"
                role="menu"
                aria-label={m.label}
                data-menu-pop={m.id}
                onKeyDown={(e) => onPopKeyDown(e, m)}
              >
                {m.items.map((it, i) =>
                  isItem(it) ? (
                    <button
                      key={it.id}
                      type="button"
                      role={it.checked !== undefined ? 'menuitemcheckbox' : 'menuitem'}
                      aria-checked={it.checked !== undefined ? it.checked : undefined}
                      className="menu-item"
                      disabled={it.disabled}
                      title={it.disabled ? (it.disabledReason ?? '当前不可用') : it.title}
                      onClick={() => {
                        if (it.disabled) return;
                        it.run();
                        closeMenu(m.id);
                      }}
                    >
                      <span className="menu-ico">{it.icon ? <Icon name={it.icon} size={13} /> : null}</span>
                      <span className="menu-label">{it.label}</span>
                      {/* 复选标记列常驻占位，有标记与无标记的菜单项对齐 */}
                      <span className="menu-check">
                        {it.checked !== undefined && it.checked ? <Icon name="circle-check" size={13} /> : null}
                      </span>
                    </button>
                  ) : (
                    <div key={`sep-${i}`} className="menu-sep" role="separator" />
                  ),
                )}
              </div>
            )}
          </div>
        );
      })}
    </nav>
  );
}
