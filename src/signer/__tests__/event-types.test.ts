import { describe, it, expectTypeOf } from 'vitest';
import type {
  SignInviteDetectedEvent,
  SignSummarizedEvent,
  SignApprovalRequestedEvent,
  SignApprovedEvent,
  SignCancelledEvent,
  SignSigningStartedEvent,
  SignFieldInputNeededEvent,
  SignFieldInputProvidedEvent,
  SignCompletedEvent,
  SignFailedEvent,
  EventMap,
} from '../../events.js';

describe('signer event types', () => {
  it('sign.invite.detected shape', () => {
    expectTypeOf<SignInviteDetectedEvent['payload']>().toEqualTypeOf<{
      ceremonyId: string;
      emailId: string;
      vendor: 'docusign';
      signUrl: string;
      groupId: string;
    }>();
  });

  it('EventMap includes all sign.* events', () => {
    expectTypeOf<
      EventMap['sign.invite.detected']
    >().toEqualTypeOf<SignInviteDetectedEvent>();
    expectTypeOf<
      EventMap['sign.summarized']
    >().toEqualTypeOf<SignSummarizedEvent>();
    expectTypeOf<
      EventMap['sign.approval_requested']
    >().toEqualTypeOf<SignApprovalRequestedEvent>();
    expectTypeOf<
      EventMap['sign.approved']
    >().toEqualTypeOf<SignApprovedEvent>();
    expectTypeOf<
      EventMap['sign.cancelled']
    >().toEqualTypeOf<SignCancelledEvent>();
    expectTypeOf<
      EventMap['sign.signing_started']
    >().toEqualTypeOf<SignSigningStartedEvent>();
    expectTypeOf<
      EventMap['sign.field_input_needed']
    >().toEqualTypeOf<SignFieldInputNeededEvent>();
    expectTypeOf<
      EventMap['sign.field_input_provided']
    >().toEqualTypeOf<SignFieldInputProvidedEvent>();
    expectTypeOf<
      EventMap['sign.completed']
    >().toEqualTypeOf<SignCompletedEvent>();
    expectTypeOf<EventMap['sign.failed']>().toEqualTypeOf<SignFailedEvent>();
  });
});
