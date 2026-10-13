import { describe, expect, it } from "vitest";
import { errorFields } from "./error-fields";

// Independent inventory of existing authored throws, helper call sites and
// worker diagnostics/retry regressions. New registry omissions fail here.
const preservedCodes = [
  "account_credential_encryption_key_must_be_distinct",
  "account_mail_configuration_incomplete",
  "account_mail_database_cancelled",
  "account_mail_delivery_failed",
  "account_mail_expired",
  "account_mail_stop_timed_out",
  "account_reset_expected_email_required",
  "active_run_status_invalid",
  "ambiguous_applicant_google_credentials",
  "ambiguous_applicant_sheet_source",
  "applicant_collection_unavailable",
  "applicant_google_auth_invalid",
  "applicant_google_auth_rejected",
  "applicant_google_auth_unavailable",
  "applicant_identity_invalid",
  "applicant_identity_unavailable",
  "applicant_resolver_unavailable",
  "applicant_sheet_bounds_exceeded",
  "applicant_sheet_read_rejected",
  "applicant_sheet_response_invalid",
  "applicant_sheet_unavailable",
  "applicant_watcher_configuration_required",
  "blizzard_client_id_required",
  "blizzard_client_secret_required",
  "blizzard_forbidden",
  "blizzard_max_concurrent_invalid",
  "blizzard_max_per_second_invalid",
  "blizzard_not_found",
  "blizzard_schema_drift",
  "blizzard_sweep_request_cap_required",
  "blizzard_transient",
  "changelog_repository_missing",
  "character_attendance_search_time_invalid",
  "character_connections_family_mismatch",
  "character_connections_observer_missing",
  "character_connections_run_missing",
  "character_connections_run_root_mismatch",
  "character_evidence_active_limit_out_of_range",
  "character_evidence_attempt_invalid",
  "character_evidence_credential_cutoff_invalid",
  "character_evidence_enqueue_not_created",
  "character_evidence_error_invalid",
  "character_evidence_guild_invalid",
  "character_evidence_limitation_invalid",
  "character_evidence_phase_not_found",
  "character_evidence_phase_plan_conflict",
  "character_evidence_progress_time_invalid",
  "character_evidence_publication_invalid",
  "character_evidence_repository_unavailable",
  "character_evidence_reservation_time_invalid",
  "character_evidence_resume_time_invalid",
  "character_evidence_run_cost_attempt_invalid",
  "character_evidence_run_cost_cutoff_invalid",
  "character_evidence_run_not_active",
  "character_evidence_run_not_enqueuable",
  "character_evidence_tier_search_raid_invalid",
  "character_evidence_tier_search_time_invalid",
  "character_mythic_kill_parse_invalid",
  "character_mythic_kill_performance_invalid",
  "character_raiderio_tier_read_time_invalid",
  "character_terminal_tier_time_invalid",
  "concurrency_limit_invalid",
  "database_url_required",
  "discovery_queue_enqueue_not_created",
  "discovery_queue_not_ready",
  "discovery_queue_stop_timeout",
  "discovery_retryable",
  "discovery_run_not_active",
  "discovery_run_not_found",
  "discovery_run_root_mismatch",
  "evidence_cache_capacity",
  "evidence_job_credential_encryption_key_required",
  "evidence_phase_plan_invalid",
  "evidence_phase_transition_invalid",
  "evidence_phase_unknown",
  "evidence_points_budget_low",
  "expected_row_missing",
  "fingerprint_admission_dispatch_limit_out_of_range",
  "fingerprint_admission_enqueue_not_created",
  "fingerprint_admission_queue_unavailable",
  "fingerprint_admission_time_invalid",
  "fingerprint_admission_waiting",
  "fingerprint_cap_reached",
  "fingerprint_cleanup_time_invalid",
  "fingerprint_finish_time_invalid",
  "fingerprint_hourly_budget_out_of_range",
  "fingerprint_release_failed",
  "fingerprint_release_time_invalid",
  "fingerprint_request_cap_exceeds_hourly_budget",
  "fingerprint_request_cap_out_of_range",
  "fingerprint_request_count_out_of_range",
  "fingerprint_request_time_invalid",
  "fingerprint_reservation_not_active",
  "fingerprint_stranded_failures_out_of_range",
  "fingerprint_stranded_limit_out_of_range",
  "fingerprint_waiting_limit_out_of_range",
  "fingerprint_waiting_run_not_running",
  "guild_not_found",
  "guild_reads_dropped_out_of_range",
  "health_server_address_unavailable",
  "history_limit_out_of_range",
  "identity_evidence_missing",
  "incomplete_warcraft_logs_credentials",
  "invalid_account_credential_encryption_key",
  "invalid_account_credentials",
  "invalid_applicant_backlog",
  "invalid_applicant_dossier_base_url",
  "invalid_applicant_minimum_points",
  "invalid_applicant_per_day",
  "invalid_applicant_per_tick",
  "invalid_applicant_poll_cadence",
  "invalid_applicant_queue_depth",
  "invalid_applicant_sheet_column",
  "invalid_applicant_sheet_url",
  "invalid_applicant_watcher_enabled",
  "invalid_base_url",
  "invalid_blizzard_base_url",
  "invalid_blizzard_hourly_request_budget",
  "invalid_blizzard_sweep_request_cap",
  "invalid_character_id",
  "invalid_character_key",
  "invalid_character_url",
  "invalid_client_credentials",
  "invalid_credential_encryption_key",
  "invalid_cursor",
  "invalid_database_startup_attempts",
  "invalid_database_startup_retry",
  "invalid_database_url",
  "invalid_discovery_request_cap",
  "invalid_evidence_cap_retry_ms",
  "invalid_evidence_failure_cooldown_ms",
  "invalid_evidence_job_id",
  "invalid_evidence_kill_settle_days",
  "invalid_evidence_parse_request_cap",
  "invalid_evidence_points_reserve",
  "invalid_evidence_priority",
  "invalid_evidence_request_cap",
  "invalid_evidence_resume_sweep_limit",
  "invalid_evidence_retry_cost_ceiling",
  "invalid_evidence_tier_search_request_cap",
  "invalid_evidence_transient_retry_ms",
  "invalid_fingerprint_minimum_common",
  "invalid_fingerprint_minimum_identical_percent",
  "invalid_fingerprint_sweep_cadence_hours",
  "invalid_freshness_hours",
  "invalid_guild_identity",
  "invalid_job_response",
  "invalid_maintainer_alert_webhook_url",
  "invalid_negative_cache_ttl",
  "invalid_operator_credential",
  "invalid_operator_origin",
  "invalid_operator_session_hash_secret",
  "invalid_port",
  "invalid_raid_catalogue",
  "invalid_raider_io_timeout_ms",
  "invalid_rankings_failure_code",
  "invalid_response",
  "invalid_roster_profile_answer",
  "invalid_roster_profile_locator",
  "invalid_roster_profile_time",
  "invalid_timeout",
  "invalid_token_response",
  "invalid_warcraft_logs_base_url",
  "invalid_worker_abort_grace",
  "invalid_worker_drain_timeout",
  "invalid_worker_health_host",
  "logged_encounter_not_a_mythic_kill",
  "missing_pair",
  "operator_login_expiry_out_of_range",
  "operator_login_limit_out_of_range",
  "operator_login_retry_missing",
  "pending_dispatch_limit_out_of_range",
  "points_budget_low",
  "raiderio_forbidden",
  "raiderio_logged_encounter_row_invalid",
  "raiderio_not_found",
  "raiderio_schema_drift",
  "raiderio_transient",
  "rank_lookup_abandoned",
  "rankings_unavailable",
  "rate_limit_expiry_out_of_range",
  "rate_limit_out_of_range",
  "rate_limit_retry_missing",
  "retry_delay_update_failed",
  "search_reservation_charge_missing",
  "search_reservation_not_cancellable",
  "search_reservation_not_found",
  "snapshot_not_found",
  "snapshot_root_missing",
  "stale_fingerprint_delivery",
  "stored_first_kills_unread",
  "token_deadline",
  "trusted_client_ip_unavailable",
  "warcraft_logs_character_id_invalid",
  "warcraft_logs_character_id_time_invalid",
  "warcraft_logs_client_id_required",
  "warcraft_logs_client_secret_required",
  "warcraftlogs_forbidden",
  "warcraftlogs_not_found",
  "warcraftlogs_schema_drift",
  "warcraftlogs_transient",
  "worker_health_probe_invalid",
  "worker_queue_depth_invalid",
  "worker_shutdown"
] as const;

describe("safe error diagnostics", () => {
  it.each(preservedCodes)("preserves authored code %s", (code) => {
    expect(errorFields(new Error(code)).errorCode).toBe(code);
    expect(
      errorFields(Object.assign(new Error("private payload"), { code }))
        .errorCode
    ).toBe(code);
  });
  it("prefers a literal name after constructor renaming", () => {
    class Stable extends Error {
      override readonly name = "RankingLookupFailure";
    }
    Object.defineProperty(Stable, "name", { value: "te" });
    expect(errorFields(new Stable("rankings_unavailable"))).toEqual({
      errorName: "RankingLookupFailure",
      errorCode: "rankings_unavailable"
    });
  });
  it.each([
    "private_character_realm",
    "23505",
    "1234567890",
    "unauthorized",
    "https://private.example"
  ])("rejects unregistered message %s", (message) => {
    expect(errorFields(new Error(message)).errorCode).toBeNull();
  });
  it.each(["23505", "23514", "40P01", "57P01", "08006", "XX000"])(
    "admits driver SQLSTATE %s",
    (code) => {
      expect(
        errorFields(Object.assign(new Error("private row"), { code })).errorCode
      ).toBe(code);
    }
  );
  it.each([
    "ZZ000",
    "99999",
    "2350",
    "235050",
    "40p01",
    "private_character_realm",
    "ECONNRESET"
  ])("rejects driver code %s", (code) => {
    expect(
      errorFields(Object.assign(new Error("private payload"), { code }))
        .errorCode
    ).toBeNull();
  });
  it("prefers a valid driver code and falls back only to a registered message", () => {
    expect(
      errorFields(
        Object.assign(new Error("rankings_unavailable"), { code: "23505" })
      ).errorCode
    ).toBe("23505");
    expect(
      errorFields(
        Object.assign(new Error("rankings_unavailable"), {
          code: "unknown_code"
        })
      ).errorCode
    ).toBe("rankings_unavailable");
  });
  it("bounds names and keeps generic constructor and non-error fallbacks", () => {
    expect(errorFields(new TypeError("private payload"))).toEqual({
      errorName: "TypeError",
      errorCode: null
    });
    expect(errorFields("private payload")).toEqual({
      errorName: "string",
      errorCode: null
    });
    expect(
      errorFields(Object.assign(new Error(), { name: "!" })).errorName
    ).toBe("unknown");
    expect(
      errorFields(Object.assign(new Error(), { name: "X".repeat(80) }))
        .errorName
    ).toHaveLength(64);
  });
});

it.each(["error", "ERROR", "Error", ""])(
  "uses the pg-shaped DatabaseError constructor for generic name %s",
  (name) => {
    class DatabaseError extends Error {
      readonly code = "23505";
    }
    const error = Object.assign(new DatabaseError("private row"), { name });
    expect(errorFields(error)).toEqual({
      errorName: "DatabaseError",
      errorCode: "23505"
    });
  }
);
