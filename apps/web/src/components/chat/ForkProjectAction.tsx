import { Button } from '@open-design/components';
import { Icon } from '../Icon';
import styles from './ForkProjectAction.module.css';

export function ForkProjectAction({ busy, disabled, label, busyLabel, onClick }: {
  busy: boolean;
  disabled: boolean;
  label: string;
  busyLabel: string;
  onClick: () => void;
}) {
  return (
    <Button
      variant="ghost"
      className={styles.action}
      disabled={disabled || busy}
      aria-busy={busy}
      aria-label={busy ? busyLabel : label}
      title={busy ? busyLabel : label}
      onClick={onClick}
    >
      <Icon name={busy ? 'spinner' : 'fork'} size={16} />
    </Button>
  );
}
