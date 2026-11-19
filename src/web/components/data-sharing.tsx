import type { ReactNode } from 'react';
import {
  ArrowUpRight,
  ChartColumn,
  Globe2,
  LockKeyhole,
  MessageSquareText,
  type IconComponent,
} from './icons';
import {
  Button,
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
} from './ui';

const detailsUrl = 'https://nod.n8n.io/docs/trust/privacy/';

function Item({
  icon: Icon,
  title,
  state,
  children,
}: {
  icon: IconComponent;
  title: string;
  state?: string;
  children: ReactNode;
}) {
  return (
    <li>
      <Icon size={20} aria-hidden="true" />
      <div>
        <p className="data-sharing-title">
          <strong>{title}</strong>
          {state && <span>{state}</span>}
        </p>
        <p>{children}</p>
      </div>
    </li>
  );
}

const state = (on: boolean) => (on ? 'On' : 'Off');

export function DataSharing({
  usage,
  traces,
  className,
}: {
  usage?: boolean;
  traces?: boolean;
  className?: string;
}) {
  return (
    <Dialog>
      <DialogTrigger asChild>
        <button type="button" className={className}>
          How Nod uses your data
        </button>
      </DialogTrigger>
      <DialogContent className="data-sharing">
        <DialogTitle>How Nod uses your data</DialogTitle>
        <DialogDescription>
          These switches control sharing with the Nod team at n8n. Connected services also receive
          the data they need to do your work.
        </DialogDescription>
        <ul>
          {usage !== undefined && (
            <Item icon={ChartColumn} title="Usage data" state={state(usage)}>
              On by default for new owners. Your saved choice stays unchanged. Feature use, task
              types, failures, fixed About you choices and survey answers. Survey answers are sent
              as entered and may contain personal details. Chat messages and memory stay out. Usage
              data also includes browser details, screen sizes, and analytics session and window
              IDs. It has no screen recordings or session replays. Your email needs separate
              consent.
            </Item>
          )}
          {traces !== undefined && (
            <Item icon={MessageSquareText} title="Conversation traces" state={state(traces)}>
              Off by default for new owners. Conversations and app results for the team to review.
              Nod removes personal details it recognizes. Traces can still identify you. n8n&apos;s
              default service keeps them for 14 days and never uses them to train AI models.
            </Item>
          )}
          <Item icon={Globe2} title="Your models and connected apps">
            Your model services receive your conversation and what Nod reads. By default, managed
            app calls pass through n8n&apos;s connection service and Composio, including email
            content.
          </Item>
          <Item icon={LockKeyhole} title="Saved passwords and cards">
            Encrypted in Vault on your Nod computer or server. Nod fills secret values on websites
            for sign-ins and payments you allow. Tools that fill saved values do not return them to
            the model. Private content visible in screenshots can still reach your model services.
          </Item>
        </ul>
        <p>
          When Composio Zero Data Retention is on, it limits covered execution logs. Composio's own
          sign-in apps need a Composio Enterprise plan for this coverage. Composio still processes
          calls and keeps metadata. Tool search queries, files and trigger events have separate
          rules.
        </p>
        <p>
          n8n&apos;s default services store usage data and traces in the EU. Custom trace services
          use their operator&apos;s storage and retention rules. With usage sharing on, a consented
          onboarding email and any fixed About you choices you shared also go to Customer.io in the
          US. Turning a switch off stops new sends for that setting. A send already in progress can
          finish. Ask us to delete earlier data.
        </p>
        <div className="data-sharing-actions">
          <a href={detailsUrl} target="_blank" rel="noreferrer">
            Full details <ArrowUpRight size={14} aria-hidden="true" />
          </a>
          <DialogClose asChild>
            <Button>Got it</Button>
          </DialogClose>
        </div>
      </DialogContent>
    </Dialog>
  );
}
