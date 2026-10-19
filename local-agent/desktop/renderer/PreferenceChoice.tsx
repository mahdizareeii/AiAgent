import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import Icon from './Icons';
import { choiceKey, type ChoiceOption } from './choice-flow';

export default function PreferenceChoice<Value extends string>({ label, value, options, onChange, disabled, title, placeholder = 'Choose', className = '', minimumWidth = 180, testId }: {
  label: string; value: Value; options: ChoiceOption<Value>[]; onChange: (value: Value) => void;
  disabled?: boolean; title?: string; placeholder?: string; className?: string; minimumWidth?: number; testId?: string;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [placement, setPlacement] = useState({ top: 0, left: 0, width: minimumWidth, maxHeight: 280 });
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const restoreFocus = useRef(false);
  const selected = options.find(option => option.value === value);

  function close(restore: boolean) {
    restoreFocus.current = restore;
    if (restore && !disabled) trigger.current?.focus();
    setOpen(false);
  }
  function commit(index: number) {
    const option = options[index];
    if (disabled || !option || option.disabled) return;
    close(true);
    if (option.value !== value) onChange(option.value);
  }
  function onKey(event: KeyboardEvent<HTMLElement>) {
    if (disabled) return;
    const next = choiceKey({ open, activeIndex }, event.key, options, value);
    if (next.handled) { event.preventDefault(); event.stopPropagation(); }
    if (event.key === 'Tab') trigger.current?.focus();
    if (next.restoreFocus) close(true); else setOpen(next.open);
    setActiveIndex(next.activeIndex);
    if (next.commitIndex !== undefined) commit(next.commitIndex);
  }

  useLayoutEffect(() => {
    if (disabled && open) { close(true); return; }
    if (!open) {
      if (restoreFocus.current && !disabled) {
        if (document.activeElement === document.body || root.current?.contains(document.activeElement)) trigger.current?.focus();
        restoreFocus.current = false;
      }
      return;
    }
    const position = () => {
      const rect = trigger.current?.getBoundingClientRect(); if (!rect) return;
      const width = Math.min(Math.max(rect.width, minimumWidth), Math.max(80, window.innerWidth - 16));
      const desiredHeight = Math.min(320, Math.max(40, options.length * 44 + 12));
      const below = window.innerHeight - rect.bottom - 12;
      const above = rect.top - 12;
      const upwards = below < Math.min(desiredHeight, 140) && above > below;
      const maxHeight = Math.max(40, Math.min(desiredHeight, upwards ? above : below));
      setPlacement({ width, maxHeight, left: Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)),
        top: upwards ? Math.max(8, rect.top - maxHeight - 6) : rect.bottom + 6 });
    };
    position(); list.current?.focus();
    window.addEventListener('resize', position); window.addEventListener('scroll', position, true);
    return () => { window.removeEventListener('resize', position); window.removeEventListener('scroll', position, true); };
  }, [open, disabled, minimumWidth, options.length]);

  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) close(false); };
    document.addEventListener('pointerdown', outside, true);
    return () => document.removeEventListener('pointerdown', outside, true);
  }, [open]);
  useEffect(() => {
    if (open && activeIndex >= 0) document.getElementById(`${id}-option-${activeIndex}`)?.scrollIntoView({ block: 'nearest' });
  }, [open, activeIndex, id]);

  return <div className={`preference-choice ${className}`} ref={root} onBlur={event => {
    if (!restoreFocus.current && !event.currentTarget.contains(event.relatedTarget as Node | null)) close(false);
  }}>
    <button data-testid={testId} type="button" className="choice-trigger" ref={trigger} disabled={disabled} title={title}
      aria-label={`${label}: ${selected?.label ?? placeholder}`} aria-haspopup="listbox" aria-expanded={open} aria-controls={`${id}-listbox`}
      onKeyDown={onKey} onClick={() => {
        if (open) close(false);
        else { const next = choiceKey({ open: false, activeIndex }, 'Enter', options, value); setActiveIndex(next.activeIndex); setOpen(true); }
      }}><span>{selected?.label ?? placeholder}</span><Icon name="chevron" size={11} /></button>
    <div className="choice-listbox" id={`${id}-listbox`} role="listbox" aria-label={label} hidden={!open} tabIndex={-1} ref={list}
      aria-activedescendant={open && activeIndex >= 0 ? `${id}-option-${activeIndex}` : undefined} onKeyDown={onKey} style={placement}>
      {options.map((option, index) => <div key={option.value} id={`${id}-option-${index}`} role="option"
        aria-selected={option.value === value} aria-disabled={option.disabled || undefined}
        className={`choice-option ${index === activeIndex ? 'is-highlighted' : ''}`} title={option.description}
        onPointerDown={event => event.preventDefault()} onPointerMove={() => { if (!option.disabled) setActiveIndex(index); }} onClick={() => commit(index)}>
        <span>{option.label}{option.description && <small>{option.description}</small>}</span>{option.value === value && <Icon name="check" size={13} />}
      </div>)}
      {!options.length && <p className="choice-empty">No choices available</p>}
    </div>
  </div>;
}
