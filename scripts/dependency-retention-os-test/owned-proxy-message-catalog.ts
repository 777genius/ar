// TEST-only message observations; never errno, launch, unit or retry authority.
// Primary source: https://github.com/systemd/systemd/tree/v255
// src/run/run.c: 88eca0fd6d172c1d68bc0473b65c92326ee735b5
// src/shared/bus-unit-util.c: 4ee9706847d93231d1dc3fefd56b26d7f1d9a8fe
// src/shared/bus-util.c: 4123152d93a91944af83d6cb51f383cdbfe002ea
// src/shared/bus-util.h: 869c639aeb44e7cacbb2a7627ed62c14b36e5052
// Exact static templates are retained, but formatted DATA is never captured or
// returned. Ubuntu patches can introduce messages absent from this catalogue.
const templates = [
  ["run_parse_nice", "Failed to parse nice value: %s"],
  ["run_assign_environment", "Cannot assign environment variable %s: %m"],
  ["run_parse_calendar", "Failed to parse calendar event specification: %m"],
  ["run_next_calendar", "Failed to calculate next time calendar expression elapses: %m"],
  ["run_current_directory", "Failed to get current working directory: %m"],
  ["run_single_trigger", "Only single trigger (path, socket, timer) unit can be created."],
  ["run_shell_command_conflict", "If --shell is used, no command line is expected."],
  ["run_determine_shell", "Failed to determine shell: %m"],
  ["run_command_required", "Command line to execute required."],
  ["run_remote_user", "Execution in user context is not supported on remote systems."],
  ["run_remote_scope", "Scope execution is not supported on remote systems."],
  ["run_scope_service_options", "--remain-after-exit and --service-type= are not supported in --scope mode."],
  ["run_pipe_scope_timer", "--pty/--pipe is not compatible in timer or --scope mode."],
  ["run_pipe_remote", "--pty/--pipe is only supported when connecting to the local system or containers."],
  ["run_pipe_no_block", "--pty/--pipe is not compatible with --no-block."],
  ["run_scope_trigger", "Path, socket or timer options are not supported in --scope mode."],
  ["run_timer_property_without_trigger", "--timer-property= has no effect without any other timer options."],
  ["run_wait_no_block", "--wait may not be combined with --no-block."],
  ["run_wait_trigger", "--wait may not be combined with path, socket or timer operations."],
  ["run_wait_scope", "--wait may not be combined with --scope."],
  ["run_bus_connection_kind", "Can't determine if bus connection is direct or to broker: %m"],
  ["run_pid_slice", "Failed to get PID slice: %m"],
  ["run_mangle_slice", "Failed to mangle name '%s': %m"],
  ["run_random_unit", "Failed to generate random run unit name: %m"],
  ["run_unique_name", "Unique name %s has unexpected format."],
  ["run_query_unit_state", "Failed to query unit state: %s"],
  ["run_pty_forwarding", "Error on PTY forwarding logic: %m"],
  ["run_start_transient", "Failed to start transient %s unit: %s"],
  ["run_invocation_id", "Failed to request invocation ID for unit: %s"],
  ["run_uuid_size", "Invalid UUID size, %zu != %zu."],
  ["run_acquire_pty", "Failed to acquire pseudo tty: %m"],
  ["run_tty_name", "Failed to determine tty name: %m"],
  ["run_unlock_tty", "Failed to unlock tty: %m"],
  ["run_system_bus", "Failed to connect to system bus: %m"],
  ["run_machine_pty", "Failed to get machine PTY: %s"],
  ["run_duplicate_fd", "Failed to duplicate master fd: %m"],
  ["run_watch_jobs", "Could not watch jobs: %m"],
  ["run_mangle_unit", "Failed to mangle unit name: %m"],
  ["run_event_loop", "Failed to get event loop: %m"],
  ["run_pty_forwarder", "Failed to create PTY forwarder: %m"],
  ["run_properties_signal", "Failed to request properties changed signal match: %m"],
  ["run_attach_bus", "Failed to attach bus to event loop: %m"],
  ["run_run_event_loop", "Failed to run event loop: %m"],
  ["run_mangle_scope", "Failed to mangle scope name: %m"],
  ["run_start_transient_scope", "Failed to start transient scope unit: %s"],
  ["run_set_nice", "Failed to set nice level: %m"],
  ["run_resolve_group", "Failed to resolve group %s: %m"],
  ["run_change_gid", "Failed to change GID to %u: %m"],
  ["run_resolve_user", "Failed to resolve user %s: %m"],
  ["run_change_uid", "Failed to change UID to %u: %m"],
  ["run_change_directory", "Failed to change directory to '%s': %m"],
  ["run_expand_environment", "Failed to expand environment variables: %m"],
  ["run_execute", "Failed to execute: %m"],
  ["run_unit_suffix", "Failed to change unit suffix: %m"],
  ["run_find_executable", "Failed to find executable %s: %m"],
  ["bus_set_address_session", "Failed to set bus address: $DBUS_SESSION_BUS_ADDRESS and $XDG_RUNTIME_DIR not defined (consider using --machine=<user>@.host --user to connect to bus of other user)"],
  ["bus_set_address", "Failed to set bus address: %m"],
  ["bus_connect_session", "Failed to connect to bus: $DBUS_SESSION_BUS_ADDRESS and $XDG_RUNTIME_DIR not defined (consider using --machine=<user>@.host --user to connect to bus of other user)"],
  ["bus_connect_privilege", "Failed to connect to bus: Operation not permitted (consider using --machine=<user>@.host --user to connect to bus of other user)"],
  ["bus_connect", "Failed to connect to bus: %m"],
  ["bus_not_systemd", "System has not been booted with systemd as init system (PID 1). Can't operate."],
  ["bus_parse_message", "Failed to parse bus message: %m"],
  ["bus_create_message", "Failed to create bus message: %m"],
  ["property_parse_assignment", "Failed to parse %s=%s: %m"],
  ["property_parse_field_value", "Failed to parse %s: %s"],
  ["property_invalid_syntax", "Invalid syntax: %s"],
  ["property_exec_flags", "Failed to convert ExecCommandFlags to strv: %m"],
  ["property_parse_path", "Failed to parse path: %m"],
  ["property_parse_command", "Failed to parse command line: %m"],
  ["property_parse_argument", "Failed to parse argument: %m"],
  ["property_parse_open_file", "Failed to parse OpenFile= setting: %m"],
  ["property_parse_mount_images", "Failed to parse MountImages= property: %s"],
  ["property_parse_extension_images", "Failed to parse ExtensionImages= property: %s"],
  ["property_parse_missing", "Failed to parse %s"],
  ["property_parse_value", "Failed to parse %s value: %s"],
  ["property_serialize_cpu_set", "Failed to serialize CPUSet: %m"],
  ["property_cpu_quota_small", "CPU quota too small."],
  ["property_cpu_quota", "CPU quota '%s' invalid."],
  ["property_cpu_period", "CPU quota period '%s' invalid."],
  ["property_parse_value_period", "Failed to parse %s value %s."],
  ["property_parse_bytes", "Failed to parse byte value %s: %m"],
  ["property_parse_value_error", "Failed to parse %s value %s: %m"],
  ["property_parse_ip_prefix", "Failed to parse IP address prefix: %s"],
  ["property_parse_parameter", "Failed to parse %s= parameter: %s"],
  ["property_missing_argument", "Missing argument to %s=."],
  ["property_decode_credential", "Failed to base64 decode encrypted credential: %m"],
  ["property_unescape_value", "Failed to unescape %s= value: %s"],
  ["property_unescape_text", "Failed to unescape text '%s': %m"],
  ["property_decode_base64", "Failed to decode base64 data '%s': %m"],
  ["property_resource_limit", "Failed to parse resource limit: %s"],
  ["property_serialize_affinity", "Failed to serialize CPUAffinity: %m"],
  ["property_numa_all", "Failed to create NUMA mask representing \"all\" NUMA nodes: %m"],
  ["property_serialize_numa", "Failed to serialize NUMAMask: %m"],
  ["property_missing_colon_argument", "Missing argument after ':': %s"],
  ["property_unknown_options", "Unknown options: %s"],
  ["property_decode_root_hash", "Failed to decode RootHash= '%s': %m"],
  ["property_short_root_hash", "RootHash= '%s' is too short: %m"],
  ["property_root_signature_format", "Failed to decode RootHashSignature= '%s', not a path but doesn't start with 'base64:': %m"],
  ["property_decode_root_signature", "Failed to decode RootHashSignature= '%s': %m"],
  ["property_syntax_field", "Invalid syntax in %s: %s"],
  ["property_status_signal", "Invalid status or signal %s in %s: %m"],
  ["property_parse_assignment_no_errno", "Failed to parse %s=%s"],
  ["property_not_assignment", "Not an assignment: %s"],
  ["property_unknown_assignment", "Unknown assignment: %s"],
  ["property_load_state", "Failed to get load state of %s: %s"],
  ["property_reload_manager", "Failed to reload service manager: %s"],
] as const;
export type OwnedProxyMessageTemplateId = typeof templates[number][0] | "unknown";
const compiled = templates.map(([id, template]) => {
  const segments = template.split(/(%(?:zu|u|s|m))/);
  return { id, specificity: segments.filter((_, index) => index % 2 === 0).join("").length,
    segments };
}).sort((left, right) => right.specificity - left.specificity);

// Bounded dynamic programming, not a backtracking expression containing several
// wildcards. Every template segment visits at most line.length + 1 positions.
function matches(line: string, segments: readonly string[]): boolean {
  let reachable = new Uint8Array(line.length + 1); reachable[0] = 1;
  for (let index = 0; index < segments.length; index++) {
    const segment = segments[index]!, next = new Uint8Array(line.length + 1);
    if (index % 2 === 0) {
      for (let at = 0; at <= line.length - segment.length; at++)
        if (reachable[at] && line.startsWith(segment, at)) next[at + segment.length] = 1;
    } else if (segment === "%zu" || segment === "%u") {
      for (let at = 1; at <= line.length; at++)
        if (line.charCodeAt(at - 1) >= 48 && line.charCodeAt(at - 1) <= 57 && (reachable[at - 1] || next[at - 1])) next[at] = 1;
    } else {
      for (let at = 0; at <= line.length; at++) if (reachable[at] || at > 0 && next[at - 1]) next[at] = 1;
    }
    reachable = next;
  }
  return reachable[line.length] === 1;
}
export function ownedProxyMessageTemplateId(line: string): OwnedProxyMessageTemplateId {
  if (line.length > 4096 || !/^[\x20-\x7e]*$/.test(line)) return "unknown";
  return compiled.find(entry => matches(line, entry.segments))?.id ?? "unknown";
}
