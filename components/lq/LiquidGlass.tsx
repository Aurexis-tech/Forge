'use client';

// LiquidGlass — the AI-futuristic surface primitive. DORMANT: lives in
// components/lq/ alongside the forge primitives; no page imports it yet.
// The glass material + variants are defined in LiquidGlass.module.css; the
// cursor-tracking specular is driven by useSpecular (writes --mx/--my).
//
// Polymorphic: render as a div / button / a via `as`. <LiquidGlassButton>
// is the button-sized convenience wrapper.

import {
  type ComponentPropsWithoutRef,
  type ElementType,
  type ReactNode,
} from 'react';
import { useSpecular } from './useSpecular';
import styles from './LiquidGlass.module.css';

export type LiquidGlassVariant = 'default' | 'aurora' | 'rose' | 'disabled';

// CSS-module keys are `string | undefined` under noUncheckedIndexedAccess;
// the class-list builder below filters falsy values, so undefined is fine.
const VARIANT_CLASS: Record<LiquidGlassVariant, string | undefined> = {
  default: '',
  aurora: styles.aurora,
  rose: styles.rose,
  disabled: styles.disabled,
};

type LiquidGlassOwnProps<E extends ElementType> = {
  as?: E;
  variant?: LiquidGlassVariant;
  className?: string;
  children?: ReactNode;
};

export type LiquidGlassProps<E extends ElementType> =
  LiquidGlassOwnProps<E> &
    Omit<ComponentPropsWithoutRef<E>, keyof LiquidGlassOwnProps<E>>;

export function LiquidGlass<E extends ElementType = 'div'>({
  as,
  variant = 'default',
  className = '',
  children,
  ...rest
}: LiquidGlassProps<E>) {
  const Tag = (as ?? 'div') as ElementType;
  const isDisabled = variant === 'disabled';
  // Disabled surfaces get no specular tracking.
  const ref = useSpecular<HTMLElement>(!isDisabled);

  const classes = [styles.glass, VARIANT_CLASS[variant], className]
    .filter(Boolean)
    .join(' ');

  // A disabled surface is never a focusable action: real <button> gets the
  // `disabled` attr; everything else is taken out of the tab order +
  // marked aria-disabled.
  const disabledProps = isDisabled
    ? Tag === 'button'
      ? { disabled: true, 'aria-disabled': true }
      : { 'aria-disabled': true, tabIndex: -1 }
    : {};

  return (
    <Tag ref={ref} className={classes} {...disabledProps} {...rest}>
      {children}
    </Tag>
  );
}

export type LiquidGlassButtonProps = Omit<
  LiquidGlassProps<'button'>,
  'as'
>;

export function LiquidGlassButton({
  variant = 'aurora',
  className = '',
  children,
  ...rest
}: LiquidGlassButtonProps) {
  const classes = [styles.button, className].filter(Boolean).join(' ');
  return (
    <LiquidGlass as="button" variant={variant} className={classes} {...rest}>
      {children}
    </LiquidGlass>
  );
}
