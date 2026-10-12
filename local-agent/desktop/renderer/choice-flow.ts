export interface ChoiceOption<Value extends string = string> { value: Value; label: string; disabled?: boolean; description?: string; }
export interface ChoiceState { open: boolean; activeIndex: number; }
export interface ChoiceTransition extends ChoiceState { handled: boolean; commitIndex?: number; restoreFocus?: boolean; }

function boundary(options: ChoiceOption[], last = false): number {
  return last ? options.findLastIndex(option => !option.disabled) : options.findIndex(option => !option.disabled);
}

function move(options: ChoiceOption[], from: number, direction: number): number {
  for (let step = 1; step <= options.length; step++) {
    const index = ((from + direction * step) % options.length + options.length) % options.length;
    if (!options[index].disabled) return index;
  }
  return -1;
}

/** Navigation never commits a preference; only explicit Enter/Space or click does. */
export function choiceKey(state: ChoiceState, key: string, options: ChoiceOption[], selected: string): ChoiceTransition {
  if (key === 'Tab') return { ...state, open: false, handled: false };
  if (key === 'Escape') return { ...state, open: false, handled: state.open, restoreFocus: state.open };
  const recognized = ['ArrowDown', 'ArrowUp', 'Home', 'End', 'Enter', ' '].includes(key);
  if (!recognized) return { ...state, handled: false };
  if (!state.open) {
    const current = options.findIndex(option => option.value === selected && !option.disabled);
    const activeIndex = key === 'Home' ? boundary(options) : key === 'End' ? boundary(options, true)
      : current >= 0 ? current : boundary(options, key === 'ArrowUp');
    return { open: true, activeIndex, handled: true };
  }
  if (key === 'Enter' || key === ' ') {
    const option = options[state.activeIndex];
    return option && !option.disabled
      ? { open: false, activeIndex: state.activeIndex, handled: true, commitIndex: state.activeIndex, restoreFocus: true }
      : { ...state, handled: true };
  }
  const activeIndex = key === 'Home' ? boundary(options) : key === 'End' ? boundary(options, true)
    : state.activeIndex < 0 ? boundary(options, key === 'ArrowUp') : move(options, state.activeIndex, key === 'ArrowDown' ? 1 : -1);
  return { open: true, activeIndex, handled: true };
}
