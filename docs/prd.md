# Hermes Cloud --- Product Requirements Document

**Status:** Approved for technical specification\
**Version:** 1.0\
**Date:** 11 November 2026\
**Product category:** Managed Hermes hosting / SaaS\
**Working principle:** Customer self-service. Infrastructure autopilot.
Minimal human intervention.

------------------------------------------------------------------------

## 1. Executive Summary

Hermes Cloud is a managed hosting service that lets customers deploy and
operate their own Hermes AI agent without managing a VPS, Docker,
deployment, runtime maintenance, or infrastructure operations.

Each customer receives a dedicated Hermes runtime container and
persistent storage. Customers manage their own instance through a
self-service dashboard and retain broad control over Hermes, including
tools, custom skills, and shell access inside their own container.

Hermes Cloud manages the infrastructure lifecycle: provisioning, health
monitoring, recovery, backups, runtime upgrades, subscription lifecycle,
and capacity scheduling.

The default AI provider is NibieRouter. Customers may alternatively
configure their own provider credentials (BYOK). Hosting subscription
fees and AI token usage are separate: Hermes Cloud charges for hosting,
while AI usage is billed independently through NibieRouter or the
customer's own provider.

The initial launch is a private beta with 5--10 invited users. The
longer-term capacity target is 100 customers, achieved by scaling across
runtime nodes rather than assuming one VPS can host all tenants.

## 2. Product Vision and Positioning

### 2.1 Positioning

> Run your personal AI agent 24/7. No VPS, no setup, no infrastructure
> maintenance.

Hermes Cloud sells convenience, reliability, and managed
operations---not raw VPS capacity, a custom chatbot, or a developer
platform.

### 2.2 Target customer

-   AI enthusiasts who want to use Hermes but do not want to operate
    servers.
-   Users who want a persistent, always-on personal AI agent.
-   Users who want the freedom to configure Hermes, use tools, install
    custom skills, and access a shell inside their own runtime.

### 2.3 Core value proposition

1.  Deploy Hermes through a self-service flow.
2.  Get a dedicated, persistent runtime.
3.  Use NibieRouter by default or bring an own API key.
4.  Manage the instance from a single dashboard.
5.  Let Hermes Cloud handle infrastructure operations and maintenance.

### 2.4 Product boundaries

Hermes Cloud is a **managed Hermes hosting product**. It is not intended
to become, in the MVP:

-   A replacement Hermes agent or a proprietary agent framework.
-   A multi-agent orchestration platform.
-   A skills marketplace.
-   A general-purpose VPS product.
-   A platform that exposes host-level SSH or Docker administration to
    customers.
-   An unlimited AI token subscription.

## 3. Approved Product Decisions

  -----------------------------------------------------------------------
  Dimension                           Approved decision
  ----------------------------------- -----------------------------------
  Product                             Managed Hermes hosting

  Initial target                      AI enthusiasts

  Core problem                        Avoid VPS, Docker, deployment, and
                                      maintenance work

  Deployment isolation                Dedicated container per customer

  AI provider                         NibieRouter default, BYOK supported

  Monetization                        Hosting subscription only

  AI usage                            Billed separately; no bundled or
                                      unlimited token allowance

  Entry-level price                   Undecided; determine after resource
                                      measurement and unit economics

  Hermes permissions                  Full access to Hermes features and
                                      tools

  Shell access                        Full shell inside the customer's
                                      container

  Host access                         No host VPS SSH or host-level
                                      access

  Skills                              Built-in and customer-uploaded
                                      custom skills

  Infrastructure                      New production VPS/runtime
                                      infrastructure

  Long-term target                    100 customers

  Infrastructure budget               Flexible; upgrade/add nodes when
                                      justified

  Grace period                        3 days after subscription
                                      expiry/payment due, subject to
                                      billing policy

  Data retention                      30 days after suspension

  Cancellation                        Instance remains active until the
                                      paid period ends

  Onboarding                          Fully self-service

  Launch                              Private beta with 5--10 invited
                                      users

  Initial support                     Telegram

  Community                           Telegram channel/community later

  Operating model                     Automation-first / autopilot
  -----------------------------------------------------------------------

## 4. User Experience and Customer Journey

### 4.1 Primary journey

1.  Customer registers and verifies their account.
2.  Customer selects a hosting plan and deployment region (where
    available).
3.  Customer enters an instance/app name.
4.  Customer reviews the resource specification, billing cycle, and
    price.
5.  Customer pays using the supported payment method (QRIS/payment
    gateway).
6.  Payment webhook is verified server-side.
7.  Provisioning is queued and the customer sees deployment progress.
8.  Hermes Cloud creates the tenant runtime, persistent volume, and
    configuration.
9.  Customer configures Telegram and selects NibieRouter or BYOK.
10. Health checks pass and the instance becomes Active.
11. Customer manages the instance through the dashboard.

### 4.2 Deployment page

The deployment experience should follow the familiar managed-app
deployment pattern shown in the supplied Sumopod reference:

-   App/instance name.
-   Region selection, only where capacity is available.
-   Plan/template selection.
-   CPU, RAM, storage, and network limits shown clearly.
-   Monthly billing cycle and price.
-   A deployment summary.
-   Deploy action and visible provisioning status.

Do not advertise a region or plan unless the scheduler can place the
instance there.

### 4.3 Instance management dashboard

The instance dashboard should provide the following navigation areas:

  -----------------------------------------------------------------------
  Area                                Requirements
  ----------------------------------- -----------------------------------
  Access                              Instance URL, access instructions,
                                      generated credentials where
                                      applicable

  Hermes                              Hermes status and relevant
                                      agent/runtime management

  Monitor                             CPU, memory, disk, network, uptime,
                                      and resource history

  Logs                                Tenant-scoped application/runtime
                                      logs with secret redaction

  Upgrade & Renew                     Plan upgrade, renewal, subscription
                                      status

  Custom Domain                       Domain setup and verification, if
                                      supported by the runtime ingress
                                      architecture

  File Manager                        Tenant-scoped file browsing and
                                      file operations inside the
                                      customer's persistent volume

  Configuration                       Provider configuration,
                                      environment/configuration settings,
                                      runtime settings
  -----------------------------------------------------------------------

Instance-level actions:

-   Restart.
-   Stop/start where allowed by subscription state and product policy.
-   Open Web Console / container shell.
-   View deployment and health status.

Never expose host filesystem paths, Docker socket access, host
credentials, internal network details, or unrestricted infrastructure
logs.

### 4.4 Statuses

Customer-facing instance statuses:

-   `Pending`
-   `Provisioning`
-   `Starting`
-   `Active`
-   `Degraded`
-   `Suspended`
-   `Failed`
-   `Deleting`
-   `Deleted`

Show a useful, non-sensitive reason and next action for customer-visible
failures.

## 5. Plans, Billing, and Unit Economics

### 5.1 Monetization

-   Charge a recurring hosting subscription.
-   Bill AI token usage separately.
-   NibieRouter is the default provider path.
-   BYOK is available for customers who want to use their own provider
    account.
-   Do not bundle tokens or advertise unlimited AI usage in hosting
    plans.

### 5.2 Pricing status

Entry-level pricing is **not yet approved**. The Sumopod reference price
is a competitor benchmark only, not a validated Hermes Cloud price.

Do not finalize public pricing until the following are measured:

-   CPU and RAM usage per idle and active Hermes instance.
-   Disk usage and log growth per tenant.
-   Network and egress costs.
-   Backup storage and backup operation costs.
-   Control-plane, monitoring, and logging overhead.
-   Payment gateway fees.
-   Support and incident-response cost.
-   Expected resource contention and safety headroom.
-   Target gross margin and a reserve for abnormal usage.

### 5.3 Resource-based plans

Plans should map to enforceable runtime limits, not just marketing
labels.

Candidate plan dimensions:

-   CPU quota / shares.
-   Memory limit and reservation.
-   Persistent storage quota.
-   Process/PID limit.
-   Network/egress policy.
-   Backup retention and frequency.
-   Optional custom domain and other premium features.

The initial plan matrix and IDR price must be approved after
benchmarking. Do not assume a fixed number of tenants per VPS.

### 5.4 Payment requirements

-   Use a payment gateway that supports the selected Indonesian payment
    methods, including QRIS if available.
-   Verify webhook signature and event authenticity.
-   Validate invoice/reference, amount, currency, merchant/account, and
    payment status.
-   Use unique provider event IDs and idempotent processing.
-   Do not activate an instance based only on a browser redirect.
-   Reconcile payment provider records against internal subscription
    state.
-   Keep payment state transitions auditable.

### 5.5 Upgrade and renewal

-   Plan upgrades should calculate prorated or next-cycle charges
    according to a clearly defined billing policy.
-   Do not resize a running instance until the payment and capacity
    checks succeed.
-   If the requested plan cannot fit on the current node, schedule
    migration or report that capacity is unavailable.
-   Renewal must reactivate a suspended instance only after verified
    payment and successful capacity checks.

## 6. Technical Architecture

### 6.1 Architectural approach

Use a control-plane / data-plane architecture.

**Control plane** - Customer dashboard. - Backend API. - Authentication
and authorization. - PostgreSQL database. - Redis and background job
queue. - Billing and payment webhooks. - Provisioning and lifecycle
workers. - Runtime-node scheduler. - Monitoring, audit, and
administrative operations.

**Data plane** - Runtime nodes. - Dedicated Hermes container per
tenant. - Dedicated persistent volume per tenant. - Tenant-specific
runtime configuration and secret injection. - Ingress and egress
controls.

For private beta, control-plane and runtime workloads may temporarily
share infrastructure only if isolation and resource headroom are
demonstrated. The production design must preserve the ability to
separate them. Do not expose the Docker daemon or socket to customer
containers or the public API.

### 6.2 Suggested implementation stack

The following is a proposed implementation baseline, not a requirement
to use a specific vendor:

  -----------------------------------------------------------------------
  Layer                               Proposed technology
  ----------------------------------- -----------------------------------
  Dashboard                           Next.js + TypeScript

  Backend                             Node.js + TypeScript modular
                                      monolith

  API                                 REST, versioned under `/api/v1`

  Database                            PostgreSQL + Prisma

  Queue/cache                         Redis + BullMQ

  Runtime                             Pinned Hermes Docker image

  Provisioning                        Dedicated worker / runtime manager

  Ingress                             Reverse proxy with tenant routing

  Monitoring                          Prometheus + Grafana or equivalent

  Logs                                Centralized structured logs

  Backups                             Encrypted object storage

  Deployment                          Docker-based runtime nodes;
                                      orchestration can evolve as scale
                                      requires
  -----------------------------------------------------------------------

Keep the MVP operationally simple. Do not introduce Kubernetes solely to
meet a theoretical 100-customer target. A scheduler and repeatable
multi-node runtime manager are required; the underlying orchestration
technology can be selected based on measured complexity.

### 6.3 Tenant isolation model

-   One tenant = one dedicated Hermes container + one dedicated
    persistent volume.
-   Each runtime receives a unique tenant and instance identity.
-   Every API operation is authorized against the authenticated user's
    tenant membership.
-   Tenant IDs supplied by clients must never be trusted as
    authorization.
-   Runtime containers must not access the control-plane database,
    Redis, Docker API, other tenants, or host services.
-   The runtime manager is the only component allowed to create,
    inspect, stop, or remove containers.
-   Customer shell access is limited to their own runtime container.

### 6.4 Runtime node scheduler

The scheduler must:

-   Maintain node inventory and health.
-   Track allocatable CPU, memory, storage, and configured safety
    headroom.
-   Reserve capacity before provisioning.
-   Prevent overcommit beyond configured policy.
-   Place new instances only on eligible nodes/regions.
-   Mark nodes unschedulable when unhealthy or full.
-   Support adding nodes without changing the customer-facing product.
-   Record placement and migration events.
-   Reconcile database state against actual runtime state.

The long-term target is 100 customers across an expandable fleet. It is
not a promise that one VPS can run 100 tenants.

## 7. Runtime Security Requirements

Full shell access and custom skills mean customer workloads must be
treated as untrusted code. A standard Docker container is not, by
itself, a sufficient security guarantee.

### 7.1 Mandatory baseline

-   Run as non-root wherever Hermes compatibility permits.
-   Never run privileged containers.
-   Never mount the Docker socket into customer containers.
-   Drop unnecessary Linux capabilities.
-   Enable `no-new-privileges`.
-   Apply seccomp and AppArmor or equivalent host protections.
-   Enforce CPU, memory, PID, and disk quotas.
-   Use dedicated tenant volumes with controlled ownership and
    permissions.
-   Do not use host networking.
-   Do not mount broad host directories.
-   Keep runtime images pinned by immutable version/digest; never deploy
    `latest` in production.
-   Keep host kernel and container runtime patched.
-   Separate control-plane credentials from runtime credentials.

### 7.2 Stronger isolation assessment

Before public launch, evaluate a stronger sandbox boundary such as
gVisor or VM-based isolation (for example, microVMs). Select the
isolation technology based on Hermes compatibility, operational
complexity, performance, and threat-model testing.

The security review must explicitly test container escape resistance,
cross-tenant access, privilege escalation, filesystem boundaries,
process limits, and network restrictions.

### 7.3 Network policy and SSRF

-   Block access from tenant workloads to private control-plane
    networks, host management endpoints, cloud metadata services, and
    other tenant networks.
-   Apply controlled outbound egress for Telegram, model providers,
    package sources, and customer-configured integrations.
-   Validate custom provider URLs.
-   Prevent SSRF to loopback, private, link-local, reserved, and
    metadata IP ranges.
-   Revalidate DNS resolution at connection time and defend against DNS
    rebinding.
-   Do not assume URL validation alone is sufficient; enforce
    network-level egress policy.

### 7.4 Secrets management

-   Encrypt provider API keys, Telegram bot tokens, and other secrets at
    rest using envelope encryption.
-   Keep encryption keys outside the application database.
-   Never return plaintext secrets after initial submission.
-   Redact secrets from logs, traces, error messages, and support views.
-   Support credential replacement/rotation and revocation.
-   Do not place raw secrets in Redis job payloads; pass references to
    secret records or a secure secret broker.

### 7.5 Web Console and File Manager

-   Authenticate every action and verify tenant ownership server-side.
-   Use a narrowly scoped runtime agent/API or secure execution broker.
-   Do not pass arbitrary container IDs, host paths, or Docker
    parameters from the browser.
-   Restrict file operations to the tenant's persistent volume.
-   Validate paths and prevent traversal, symlink escapes, and writes
    outside the tenant volume.
-   Apply command/session limits, audit events, and idle timeouts to
    shell sessions.
-   Never provide host-level SSH.

### 7.6 Custom skills and extensions

-   Treat uploaded skills and their dependencies as untrusted.
-   Validate file types, size, archive paths, and executable content.
-   Scan uploads where practical.
-   Install only inside the tenant runtime.
-   Do not let skills access platform credentials or other tenants.
-   Document that customer-installed skills may execute code and can
    affect the customer's own instance.

## 8. Provider Integration

### 8.1 NibieRouter default

-   Provide a low-friction default integration with NibieRouter.
-   Prefer a tenant-scoped API key or sub-account credential if
    supported by the NibieRouter backend.
-   Ensure usage attribution can be mapped to the correct Hermes Cloud
    tenant.
-   Display AI usage only when upstream usage data is authoritative and
    available.
-   Keep hosting billing and AI usage billing separate.

### 8.2 BYOK

-   Allow customers to enter their own supported provider credentials.
-   Encrypt credentials at rest.
-   Provide a connection/test action without exposing the key.
-   Support update, replacement, and removal.
-   Validate custom base URLs and enforce SSRF protections.
-   Clearly explain that provider charges are billed by the provider,
    not Hermes Cloud.

### 8.3 Provider failure behavior

-   Distinguish provider errors from runtime/container failures.
-   Do not restart a healthy Hermes runtime solely because an upstream
    model provider is unavailable.
-   Show actionable provider connection status and sanitized error
    details.

## 9. Telegram Integration

Telegram is the first supported messaging channel.

Requirements:

-   Customer creates and supplies their own Telegram bot token (for
    example, through BotFather).
-   Validate the token server-side using Telegram's bot identity
    endpoint.
-   Store the token encrypted.
-   Configure the customer's Hermes instance.
-   Verify that the bot can receive and respond to a test message.
-   Support token replacement and revocation.
-   Redact tokens from all logs and UI responses.
-   Apply Hermes pairing/allowlist controls and document the recommended
    secure configuration.
-   Select polling or webhook mode based on the supported Hermes gateway
    behavior and deployment architecture.
-   Do not assume one bot token can safely be shared between multiple
    tenants.

A Telegram community/channel may be introduced later. It is not a launch
dependency.

## 10. Subscription and Instance Lifecycle

### 10.1 Approved policy

-   Grace period: 3 days.
-   Data retention after suspension: 30 days.
-   Cancellation: service remains active until the paid period ends.

The exact start timestamp for the grace period must be tied to the
subscription's due/expiry policy and shown clearly to customers.

### 10.2 Lifecycle

``` text
PENDING
  -> PROVISIONING
  -> CONFIGURING
  -> STARTING
  -> ACTIVE

ACTIVE
  -> DEGRADED
  -> ACTIVE

ACTIVE
  -> CANCELLATION_SCHEDULED
  -> EXPIRED
  -> SUSPENDED

ACTIVE
  -> GRACE_PERIOD
  -> ACTIVE          (verified payment)
  -> SUSPENDED       (grace period elapsed)

SUSPENDED
  -> ACTIVE          (renewal paid within retention window)
  -> DELETING        (retention window elapsed)
  -> DELETED
```

### 10.3 Suspension and deletion

-   Stop the runtime after suspension to avoid continued compute
    consumption.
-   Preserve the tenant volume and required recovery metadata for 30
    days after suspension.
-   Prevent normal runtime access while suspended.
-   Notify the customer before suspension and before permanent deletion.
-   On verified renewal within the retention window, check capacity and
    restore the instance.
-   At the end of retention, delete tenant runtime data and associated
    secrets according to the published data deletion policy.
-   Record deletion completion in an audit trail.
-   Clarify backup expiration and deletion behavior in the
    customer-facing policy.

### 10.4 Cancellation

Cancellation schedules non-renewal; it does not immediately stop the
instance. The instance remains available until the current paid period
ends, then follows the expiry/grace/suspension policy.

## 11. Provisioning and Background Jobs

### 11.1 Provisioning flow

1.  Receive verified payment event.
2.  Validate event signature, amount, currency, invoice, and status.
3.  Persist payment and subscription transition idempotently.
4.  Enqueue provisioning job.
5.  Reserve capacity on an eligible runtime node.
6.  Create tenant metadata and persistent volume.
7.  Pull or use the pinned Hermes image.
8.  Generate scoped runtime configuration and secrets references.
9.  Create container with security and resource constraints.
10. Start runtime.
11. Wait for readiness and health checks.
12. Configure ingress and tenant access.
13. Mark instance Active.
14. Notify customer.

### 11.2 Job reliability

-   Jobs must be idempotent.
-   Use bounded retries with exponential backoff and jitter.
-   Record attempt count, failure reason, and timestamps.
-   Route exhausted jobs to a dead-letter queue.
-   Provide safe retry/reconciliation actions for operators.
-   Avoid duplicate volumes or containers after retries.
-   Reconcile database state with runtime-node state.
-   Use an outbox or equivalent reliable event publication pattern for
    critical state transitions.

### 11.3 Other automated jobs

-   Health checks.
-   Runtime restart/recovery.
-   Backup and backup verification.
-   Subscription reminders.
-   Expiry and suspension.
-   Retention deletion.
-   Capacity reconciliation.
-   Runtime version updates.
-   Node health and capacity updates.

## 12. Backup and Restore

-   Back up tenant persistent data on a defined schedule.
-   Take a backup before destructive upgrades or migrations.
-   Encrypt backups in transit and at rest.
-   Store backups outside the runtime node.
-   Track backup status, size, checksum, timestamp, and tenant
    ownership.
-   Define retention separately from the 30-day suspended-instance
    retention policy.
-   Test restoration before production launch.
-   Restore into a new volume or isolated recovery environment, verify
    integrity, then switch traffic.
-   Never run two active containers against the same writable tenant
    volume during restore or migration.

Initial backup frequency and backup retention are operational decisions
to validate during beta; they must be documented before paid public
launch.

## 13. Monitoring, Reliability, and Autopilot

### 13.1 Health layers

Monitor separately:

1.  Node health.
2.  Container/runtime process health.
3.  Hermes gateway readiness.
4.  Telegram connectivity.
5.  Provider connectivity.
6.  CPU, memory, disk, PID, and network usage.
7.  Subscription/payment state.
8.  Backup and restore health.

### 13.2 Recovery behavior

-   Restart a crashed runtime with bounded backoff.
-   Mark an instance Degraded after repeated failures.
-   Alert operators when automated recovery is exhausted.
-   Do not restart for provider-only outages.
-   Detect disk pressure and apply documented log/storage policies.
-   Stop scheduling new tenants on unhealthy or over-capacity nodes.
-   Preserve diagnostic events while redacting secrets.

### 13.3 Autopilot principle

The normal customer journey and routine infrastructure operations should
not require manual operator action.

Human intervention is reserved for exceptions such as:

-   Runtime node failure.
-   Suspected abuse or security incident.
-   Payment reconciliation failure.
-   Failed backup restoration.
-   Capacity exhaustion.
-   Platform-wide deployment failure.

The system must expose an operational queue of exceptions with tenant,
node, event history, impact, and safe remediation actions.

## 14. Data Model

Proposed relational entities:

  Entity                    Purpose
  ------------------------- -----------------------------------------------
  `users`                   Customer identity and authentication
  `tenants`                 Customer workspace / isolation boundary
  `tenant_members`          User-to-tenant membership and role
  `plans`                   Plan definitions and resource limits
  `subscriptions`           Subscription period and lifecycle
  `payments`                Payment provider transactions
  `payment_events`          Idempotent webhook/event records
  `instances`               Hermes runtime instance metadata
  `runtime_nodes`           Runtime host inventory and capacity
  `provider_configs`        Encrypted NibieRouter/BYOK configuration
  `telegram_connections`    Encrypted Telegram bot configuration
  `backups`                 Backup metadata and integrity status
  `instance_events`         Provisioning and lifecycle event history
  `audit_logs`              Security-sensitive and administrative actions
  `jobs` / queue metadata   Background task tracking, as appropriate

### 14.1 Data rules

-   Use UUIDs for externally visible resource identifiers.
-   Store timestamps in UTC.
-   Store IDR amounts as integer minor units (rupiah integer; do not use
    floating-point currency).
-   Add unique constraints for payment provider event IDs and
    transaction references.
-   Scope tenant-owned records by `tenant_id`.
-   Use server-side authorization for all tenant operations.
-   Consider PostgreSQL row-level security as defense-in-depth, not as a
    replacement for application authorization.
-   Store secret ciphertext and key/version metadata, never plaintext
    secrets.
-   Keep an auditable event history for payment, provisioning,
    suspension, deletion, and security-sensitive actions.

## 15. API Requirements

Base path: `/api/v1`

The API is a proposed contract outline. Exact request/response schemas,
authentication mechanism, error catalog, and OpenAPI specification must
be completed during implementation design.

### 15.1 Authentication and account

``` text
POST   /auth/register
POST   /auth/login
POST   /auth/logout
GET    /me
```

### 15.2 Plans and billing

``` text
GET    /plans
GET    /subscriptions/current
POST   /subscriptions/checkout
POST   /subscriptions/cancel
POST   /subscriptions/renew
POST   /subscriptions/upgrade
GET    /payments/:paymentId
POST   /webhooks/payments/:provider
```

### 15.3 Instances

``` text
POST   /instances
GET    /instances
GET    /instances/:instanceId
GET    /instances/:instanceId/status
POST   /instances/:instanceId/restart
POST   /instances/:instanceId/start
POST   /instances/:instanceId/stop
GET    /instances/:instanceId/usage
GET    /instances/:instanceId/logs
```

### 15.4 Provider configuration

``` text
GET    /instances/:instanceId/providers
PUT    /instances/:instanceId/providers
POST   /instances/:instanceId/providers/test
DELETE /instances/:instanceId/providers/:providerConfigId
```

### 15.5 Telegram

``` text
GET    /instances/:instanceId/telegram
PUT    /instances/:instanceId/telegram
POST   /instances/:instanceId/telegram/verify
DELETE /instances/:instanceId/telegram
```

### 15.6 File Manager and Web Console

``` text
GET    /instances/:instanceId/files
POST   /instances/:instanceId/files
GET    /instances/:instanceId/files/content
PUT    /instances/:instanceId/files/content
DELETE /instances/:instanceId/files
POST   /instances/:instanceId/console/sessions
DELETE /instances/:instanceId/console/sessions/:sessionId
```

These endpoints must use a tenant-scoped execution broker. Do not expose
Docker operations or accept arbitrary host paths/container IDs.

### 15.7 Backups and audit

``` text
GET    /instances/:instanceId/backups
POST   /instances/:instanceId/backups
POST   /instances/:instanceId/backups/:backupId/restore
GET    /instances/:instanceId/events
GET    /audit-logs
```

### 15.8 API behavior

-   Return `202 Accepted` and a job identifier for asynchronous
    provisioning, restart, restore, and other long-running operations.
-   Enforce tenant authorization on every resource access.
-   Use idempotency keys for payment and provisioning-sensitive actions.
-   Return sanitized errors; never return secrets or infrastructure
    credentials.
-   Apply rate limits to authentication, console, file, and provisioning
    endpoints.
-   Maintain an OpenAPI specification and contract tests.

## 16. Admin and Operator Console

An internal operator console is required even though customer onboarding
is self-service.

Minimum capabilities:

-   Search customer, tenant, instance, and subscription.
-   Inspect node health and allocatable capacity.
-   View provisioning job state and retry safe failures.
-   Suspend or restore an instance through audited actions.
-   Inspect sanitized logs and lifecycle events.
-   Trigger backup verification and recovery workflows.
-   Mark a node unschedulable.
-   View payment reconciliation exceptions.
-   Review security and abuse alerts.
-   Inspect platform-wide capacity and cost metrics.

Admin access must use strong authentication, least privilege, and audit
logging.

## 17. Non-Functional Requirements

### 17.1 Reliability

Initial targets are hypotheses to validate during private beta, not
public guarantees:

-   Provisioning success rate: at least 95%.
-   Successful self-service onboarding: at least 90%.
-   Service availability target: 99% monthly, subject to measurement and
    explicit SLA policy.
-   Backup job success: at least 98%.
-   Automated recovery for known transient failures.
-   No cross-tenant data access.

### 17.2 Performance

-   Dashboard status and configuration requests should feel responsive
    under normal load.
-   Long-running work must be asynchronous.
-   Provisioning time should be measured at p50/p95 before setting a
    customer-facing promise.
-   File Manager and Web Console must enforce timeouts and resource
    ceilings.

### 17.3 Scalability

-   Support multiple runtime nodes.
-   Add capacity without changing tenant-facing instance identity.
-   Use capacity reservations and safety headroom.
-   Avoid single-node assumptions in data models and APIs.
-   Define node-drain and migration workflows before production scale.

### 17.4 Observability

-   Structured logs with tenant/instance correlation IDs.
-   Metrics for node and tenant resource usage.
-   Distributed trace/correlation across API, queue, worker, and runtime
    manager.
-   Alert on node failures, queue backlog, payment webhook failures,
    backup failures, and capacity thresholds.
-   Redact credentials and sensitive customer data.

## 18. Launch Plan

### Phase 0 --- Technical validation

-   Confirm Hermes containerization and persistent data paths.
-   Measure idle and active CPU/RAM/disk usage.
-   Validate Web Console and File Manager access design.
-   Test NibieRouter and BYOK integration.
-   Select and test runtime isolation approach.
-   Validate Telegram setup.
-   Run cross-tenant and network isolation tests.

### Phase 1 --- Platform foundation

-   Authentication and tenant model.
-   Database and migrations.
-   Runtime-node inventory and scheduler.
-   Provisioning worker and idempotent job system.
-   Dedicated volume and container lifecycle.
-   Basic health monitoring.

### Phase 2 --- Customer product

-   Self-service deployment flow.
-   Subscription checkout and payment webhook.
-   Instance management dashboard.
-   Provider configuration.
-   Telegram integration.
-   Logs and resource monitoring.
-   Restart and configuration workflows.

### Phase 3 --- Autopilot and recovery

-   Automated backups and restore drill.
-   Renewal, grace period, suspension, and retention deletion.
-   Restart/recovery policies.
-   Capacity alerts and node scheduling.
-   Upgrade workflow with staged rollout and rollback.
-   Operator exception console.

### Phase 4 --- Private beta

-   Invite 5--10 users.
-   Observe real resource usage and customer behavior.
-   Validate self-service onboarding.
-   Measure support requests and manual interventions.
-   Test suspension/reactivation and restore.
-   Fix isolation and reliability issues before expanding.

### Phase 5 --- Controlled scale-up

-   Add runtime nodes based on measured demand.
-   Revalidate plan economics.
-   Expand toward 100 customers.
-   Introduce Telegram community/channel later.
-   Public launch only after release gates are met.

## 19. Acceptance Criteria

### P0 --- Product functionality

-   [ ] Customer can register and authenticate.
-   [ ] Customer can select a plan and complete checkout.
-   [ ] Verified payment automatically provisions a dedicated Hermes
    instance.
-   [ ] Instance has persistent tenant-specific storage.
-   [ ] Customer can access and manage their Hermes instance.
-   [ ] Customer can use full shell access inside their own container.
-   [ ] Customer can use built-in and custom skills within their
    runtime.
-   [ ] Customer can configure NibieRouter.
-   [ ] Customer can configure BYOK.
-   [ ] Customer can configure and verify their Telegram bot.
-   [ ] Customer can restart and inspect instance health.
-   [ ] Customer can inspect resource usage and sanitized logs.
-   [ ] Customer can manage files inside their own persistent volume.
-   [ ] Subscription expiry, grace period, suspension, renewal, and
    deletion follow approved policy.
-   [ ] Backup and restore workflow is operational.

### P0 --- Security

-   [ ] No customer container has Docker socket access.
-   [ ] No customer container runs privileged.
-   [ ] Host-level SSH is not exposed to customers.
-   [ ] CPU, RAM, PID, and storage limits are enforced.
-   [ ] Tenant data and volumes are isolated.
-   [ ] Network policy blocks access to control-plane and other tenant
    infrastructure.
-   [ ] SSRF and metadata access protections are tested.
-   [ ] Secrets are encrypted and redacted.
-   [ ] Payment webhooks are authenticated and idempotent.
-   [ ] Tenant authorization is tested for every customer-facing
    endpoint.
-   [ ] File Manager path traversal and symlink escape tests pass.
-   [ ] Web Console is tenant-scoped and audited.
-   [ ] Security review validates the chosen sandbox/isolation boundary
    for untrusted code.

### P1 --- Operations

-   [ ] Failed provisioning jobs retry safely.
-   [ ] Dead-letter queue and operator recovery are available.
-   [ ] Node capacity scheduling prevents unsafe placement.
-   [ ] Automated runtime recovery works for known transient failures.
-   [ ] Backup integrity and restore drill pass.
-   [ ] Runtime upgrade and rollback workflow is tested.
-   [ ] Alerts cover node health, capacity, payment, queue, and backup
    failures.
-   [ ] Operator actions are audited.

### Release gate

Do not move from private beta to public paid launch until:

1.  All P0 functionality and security criteria pass.
2.  Cross-tenant access tests pass.
3.  Payment webhook idempotency and reconciliation are verified.
4.  Backup restoration has been demonstrated.
5.  Runtime isolation has passed security testing.
6.  Resource limits and capacity scheduling are enforced.
7.  Pricing is supported by measured unit economics.

## 20. Product Metrics

Track:

-   Number of registered customers.
-   Paid conversion.
-   Provisioning success rate and p50/p95 time.
-   Self-service onboarding completion.
-   Active, degraded, and suspended instances.
-   CPU/RAM/disk distribution per tenant.
-   Cost per active tenant.
-   Gross margin per plan.
-   NibieRouter usage attribution and BYOK adoption.
-   Backup success and restore success.
-   Automated recovery rate.
-   Manual intervention rate.
-   Support tickets per active tenant.
-   Churn and renewal rate.

Initial beta goals:

-   5--10 invited users.
-   Provisioning success ≥95%.
-   Self-service onboarding ≥90%.
-   Automated provisioning for normal cases.
-   Manual intervention below 10% of routine lifecycle events.
-   No known cross-tenant isolation failures.

## 21. Open Decisions Before Production

These are intentionally not treated as approved decisions:

1.  **Public pricing and plan matrix:** determine after runtime
    benchmarks and cost model.
2.  **Exact production VPS/node selection:** validate provider, region,
    storage, bandwidth, backup, and upgrade terms.
3.  **Isolation technology:** choose standard hardened containers versus
    gVisor or VM-based isolation after compatibility and threat-model
    tests.
4.  **Payment gateway:** select provider and finalize webhook contract.
5.  **Hermes image/version policy:** define supported release channel,
    pinning, update cadence, and rollback.
6.  **Telegram transport:** polling versus webhook based on Hermes
    compatibility and ingress design.
7.  **Custom domain implementation:** DNS verification, TLS issuance,
    routing, and plan eligibility.
8.  **Backup frequency and retention:** define RPO/RTO and retention
    costs.
9.  **Exact grace-period timestamp:** define the due-time and timezone
    policy.
10. **Plan upgrade billing:** immediate prorating versus next-cycle
    change.
11. **Abuse policy:** acceptable use, prohibited workloads, egress
    limits, and incident response.
12. **Data policy:** privacy notice, backup deletion timing, and
    permanent deletion confirmation.

## 22. Key Risks and Mitigations

  -----------------------------------------------------------------------
  Risk                    Impact                  Mitigation
  ----------------------- ----------------------- -----------------------
  Arbitrary code          Container escape or     Strong sandboxing,
  execution               host compromise         least privilege,
                                                  security testing

  Noisy neighbor          Degraded service for    Enforced quotas,
                          other tenants           scheduler headroom,
                                                  per-tenant monitoring

  Single-node failure     Multiple tenants        Multi-node
                          unavailable             architecture, external
                                                  backups, recovery
                                                  runbooks

  Uncontrolled egress     SSRF, abuse, unexpected Egress controls, URL
                          cost                    validation, rate limits

  Secret leakage          Provider or Telegram    Encryption, redaction,
                          account compromise      rotation, scoped
                                                  credentials

  Failed payment          Incorrect activation or Signed webhooks,
  processing              suspension              idempotency,
                                                  reconciliation

  Backup failure          Permanent customer data External encrypted
                          loss                    backups and restore
                                                  drills

  Underpriced plans       Negative unit economics Benchmark resource
                                                  usage and model costs
                                                  before launch

  Manual support burden   Product not truly       Self-service
                          autopilot               diagnostics, automated
                                                  recovery, exception
                                                  queue
  -----------------------------------------------------------------------

------------------------------------------------------------------------

## Appendix A --- Reference Product

The supplied Sumopod Hermes deployment and management screenshots and
documentation are product UX references. They inform the deployment flow
and instance management areas, but do not establish Hermes Cloud
pricing, security guarantees, infrastructure capacity, or implementation
details.

## Appendix B --- Core Product Principle

**Hermes Cloud manages the infrastructure; the customer controls their
Hermes runtime.**

The customer gets broad control inside their own isolated container.
Hermes Cloud retains control of the host, scheduler, billing,
provisioning, backups, monitoring, and platform security.
