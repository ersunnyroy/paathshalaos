# Database schema

_Generated from the live database by `pnpm db:schema`. Do not edit._

A browser client shows tables and columns; this exists for the part it cannot
show. Nearly every table here carries row-level security, and the policies are
the actual design — "who can see a row" matters far more in this schema than
"which columns exist".

Tables: **100** · policies: **169** · `app_*` helper functions: **12**

## The scope helpers

Policies are written in terms of these. A function marked **definer** runs as
its owner so that its own reads are plain queries rather than nested policy
evaluations — which is what keeps two policies that read each other from
recursing.

| Function | | What it answers |
| --- | --- | --- |
| `app_actor_has_finance_scope()` |  | True for roles that may see money. Deliberately narrower than app_actor_has_staff_scope(): TEACHER, ADMISSIONS, TRANSPORT and SUPPORT_AGENT are staff but are not finance. |
| `app_actor_has_integration_scope()` |  | ORG_OWNER, signed in as a person. Never an API client: a credential that can issue credentials or redirect the event stream can escalate itself. |
| `app_actor_has_staff_scope()` |  |  |
| `app_actor_has_whole_school_scope()` |  | Roles whose job is the whole institute. TEACHER and TRANSPORT are staff but are not whole-school: their reach is computed from what they actually teach or drive. |
| `app_actor_section_ids()` | **definer** | Sections this staff member teaches, is class teacher of, or is timetabled into. Empty for somebody who teaches nothing — closed by default. |
| `app_api_client_scopes()` | **definer** | The current API client's scopes. SECURITY DEFINER because api_client is readable only with integration scope, which an API client never has — without this it could not read the row that defines its own authority. |
| `app_current_actor_id()` |  |  |
| `app_current_api_client_id()` |  |  |
| `app_current_person_id()` |  |  |
| `app_current_tenant_id()` |  |  |
| `app_may_see_student()` | **definer** | Whole-school scope, or a section the actor teaches. The guardian and self branches live in app_student_visible(), which is what policies on student use. |
| `app_student_visible()` | **definer** | The single rule for who may see a learner. Both the app role's policy and the health role's policy call it, so the two cannot diverge — which they did, within three migrations of being written separately. |

## Tables

### `academic_unit`

Row-level security: **enabled**, **forced** (applies to the table owner too)

| Column | Type | Null |
| --- | --- | --- |
| id | uuid |  |
| tenant_id | uuid |  |
| campus_id | uuid |  |
| code | text |  |
| name | text |  |
| unit_type | text |  |
| board_or_affiliation | text | yes |
| created_at | timestamp with time zone |  |
| updated_at | timestamp with time zone |  |
| deleted_at | timestamp with time zone | yes |

**Policy `platform_all_tenants`** — ALL to paathshala_platform

```sql
USING true
```

```sql
WITH CHECK true
```

**Policy `tenant_isolation`** — ALL to public

```sql
USING (tenant_id = app_current_tenant_id())
```

```sql
WITH CHECK (tenant_id = app_current_tenant_id())
```

### `academic_year`

Row-level security: **enabled**, **forced** (applies to the table owner too)

| Column | Type | Null |
| --- | --- | --- |
| id | uuid |  |
| tenant_id | uuid |  |
| academic_unit_id | uuid |  |
| label | text |  |
| starts_on | date |  |
| ends_on | date |  |
| status | text |  |
| created_at | timestamp with time zone |  |
| updated_at | timestamp with time zone |  |
| deleted_at | timestamp with time zone | yes |

**Policy `tenant_isolation`** — ALL to public

```sql
USING (tenant_id = app_current_tenant_id())
```

```sql
WITH CHECK (tenant_id = app_current_tenant_id())
```

### `address`

Row-level security: **enabled**, **forced** (applies to the table owner too)

| Column | Type | Null |
| --- | --- | --- |
| id | uuid |  |
| tenant_id | uuid |  |
| person_id | uuid |  |
| label | text |  |
| line1 | text |  |
| line2 | text | yes |
| city | text |  |
| state | text |  |
| pincode | text |  |
| country | character |  |
| created_at | timestamp with time zone |  |
| updated_at | timestamp with time zone |  |
| deleted_at | timestamp with time zone | yes |

**Policy `tenant_isolation`** — ALL to paathshala_app

```sql
USING (tenant_id = app_current_tenant_id())
```

```sql
WITH CHECK (tenant_id = app_current_tenant_id())
```

### `admission_decision`

Row-level security: **enabled**, **forced** (applies to the table owner too)

| Column | Type | Null |
| --- | --- | --- |
| id | uuid |  |
| tenant_id | uuid |  |
| application_id | uuid |  |
| outcome | text |  |
| decided_by | uuid |  |
| decided_at | timestamp with time zone |  |
| offered_section_id | uuid | yes |
| offer_expires_at | timestamp with time zone | yes |
| conditions | text | yes |
| reason | text | yes |
| accepted_at | timestamp with time zone | yes |
| declined_at | timestamp with time zone | yes |
| superseded_at | timestamp with time zone | yes |
| created_at | timestamp with time zone |  |

**Policy `staff_only`** — ALL to paathshala_app

```sql
USING ((tenant_id = app_current_tenant_id()) AND app_actor_has_staff_scope())
```

```sql
WITH CHECK ((tenant_id = app_current_tenant_id()) AND app_actor_has_staff_scope())
```

### `api_client`

Row-level security: **enabled**, **forced** (applies to the table owner too)

| Column | Type | Null |
| --- | --- | --- |
| id | uuid |  |
| tenant_id | uuid |  |
| name | text |  |
| description | text | yes |
| scopes | ARRAY |  |
| status | text |  |
| rate_per_min | integer |  |
| created_by | uuid | yes |
| created_at | timestamp with time zone |  |
| updated_at | timestamp with time zone |  |

**Policy `definer_bookkeeping`** — ALL to paathshala_owner

```sql
USING true
```

```sql
WITH CHECK true
```

**Policy `integration_scope`** — ALL to paathshala_app

```sql
USING ((tenant_id = app_current_tenant_id()) AND app_actor_has_integration_scope())
```

```sql
WITH CHECK ((tenant_id = app_current_tenant_id()) AND app_actor_has_integration_scope())
```

### `api_key`

Row-level security: **enabled**, **forced** (applies to the table owner too)

| Column | Type | Null |
| --- | --- | --- |
| id | uuid |  |
| tenant_id | uuid |  |
| api_client_id | uuid |  |
| prefix | text |  |
| last_four | text |  |
| label | text | yes |
| created_by | uuid | yes |
| created_at | timestamp with time zone |  |
| expires_at | timestamp with time zone | yes |
| revoked_at | timestamp with time zone | yes |
| revoked_by | uuid | yes |
| last_used_at | timestamp with time zone | yes |

Column-level grants (narrower than the table):

- `paathshala_app` may **update** only: `label`, `revoked_by`, `revoked_at`, `last_used_at`

**Policy `definer_bookkeeping`** — ALL to paathshala_owner

```sql
USING true
```

```sql
WITH CHECK true
```

**Policy `integration_scope`** — ALL to paathshala_app

```sql
USING ((tenant_id = app_current_tenant_id()) AND app_actor_has_integration_scope())
```

```sql
WITH CHECK ((tenant_id = app_current_tenant_id()) AND app_actor_has_integration_scope())
```

### `api_key_secret`

Row-level security: **enabled**, **forced** (applies to the table owner too)

| Column | Type | Null |
| --- | --- | --- |
| api_key_id | uuid |  |
| tenant_id | uuid |  |
| secret_hash | text |  |

**Policy `auth_lookup`** — SELECT to paathshala_auth

```sql
USING true
```

**Policy `definer_bookkeeping`** — ALL to paathshala_owner

```sql
USING true
```

```sql
WITH CHECK true
```

### `application`

Row-level security: **enabled**, **forced** (applies to the table owner too)

| Column | Type | Null |
| --- | --- | --- |
| id | uuid |  |
| tenant_id | uuid |  |
| enquiry_id | uuid | yes |
| applicant_person_id | uuid |  |
| programme_id | uuid |  |
| academic_year_id | uuid |  |
| application_no | text |  |
| form_submission_id | uuid | yes |
| status | text |  |
| submitted_at | timestamp with time zone | yes |
| created_at | timestamp with time zone |  |
| updated_at | timestamp with time zone |  |
| deleted_at | timestamp with time zone | yes |

**Policy `staff_only`** — ALL to paathshala_app

```sql
USING ((tenant_id = app_current_tenant_id()) AND app_actor_has_staff_scope())
```

```sql
WITH CHECK ((tenant_id = app_current_tenant_id()) AND app_actor_has_staff_scope())
```

### `application_document`

Row-level security: **enabled**, **forced** (applies to the table owner too)

| Column | Type | Null |
| --- | --- | --- |
| id | uuid |  |
| tenant_id | uuid |  |
| application_id | uuid |  |
| document_type | text |  |
| file_id | uuid | yes |
| is_required | boolean |  |
| status | text |  |
| verified_by | uuid | yes |
| verified_at | timestamp with time zone | yes |
| rejection_reason | text | yes |
| created_at | timestamp with time zone |  |
| updated_at | timestamp with time zone |  |

**Policy `staff_only`** — ALL to paathshala_app

```sql
USING ((tenant_id = app_current_tenant_id()) AND app_actor_has_staff_scope())
```

```sql
WITH CHECK ((tenant_id = app_current_tenant_id()) AND app_actor_has_staff_scope())
```

### `assessment`

Row-level security: **enabled**, **forced** (applies to the table owner too)

| Column | Type | Null |
| --- | --- | --- |
| id | uuid |  |
| tenant_id | uuid |  |
| course_offering_id | uuid |  |
| term_id | uuid |  |
| academic_year_id | uuid |  |
| name | text |  |
| kind | text |  |
| max_marks | numeric |  |
| pass_marks | numeric | yes |
| weight_percent | numeric |  |
| grading_scale_id | uuid | yes |
| scheduled_on | date | yes |
| status | text |  |
| locked_at | timestamp with time zone | yes |
| locked_by_staff_id | uuid | yes |
| created_at | timestamp with time zone |  |
| updated_at | timestamp with time zone |  |

**Policy `structure_read`** — SELECT to paathshala_app

```sql
USING (tenant_id = app_current_tenant_id())
```

**Policy `structure_staff_write`** — ALL to paathshala_app

```sql
USING ((tenant_id = app_current_tenant_id()) AND app_actor_has_staff_scope())
```

```sql
WITH CHECK ((tenant_id = app_current_tenant_id()) AND app_actor_has_staff_scope())
```

### `attendance_correction`

Row-level security: **enabled**, **forced** (applies to the table owner too)

| Column | Type | Null |
| --- | --- | --- |
| id | uuid |  |
| tenant_id | uuid |  |
| attendance_record_id | uuid | yes |
| attendance_session_id | uuid | yes |
| enrollment_id | uuid | yes |
| from_state | text | yes |
| to_state | text |  |
| reason | text |  |
| origin | text |  |
| status | text |  |
| requested_by | uuid | yes |
| requested_at | timestamp with time zone |  |
| approved_by | uuid | yes |
| approved_at | timestamp with time zone | yes |
| rejection_reason | text | yes |
| created_at | timestamp with time zone |  |

**Policy `correction_staff_only`** — ALL to paathshala_app

```sql
USING ((tenant_id = app_current_tenant_id()) AND app_actor_has_staff_scope())
```

```sql
WITH CHECK ((tenant_id = app_current_tenant_id()) AND app_actor_has_staff_scope())
```

### `attendance_record`

Row-level security: **enabled**, **forced** (applies to the table owner too)

| Column | Type | Null |
| --- | --- | --- |
| id | uuid |  |
| tenant_id | uuid |  |
| attendance_session_id | uuid |  |
| enrollment_id | uuid |  |
| state | text |  |
| minutes_late | integer | yes |
| source | text |  |
| client_event_id | uuid | yes |
| device_recorded_at | timestamp with time zone | yes |
| recorded_at | timestamp with time zone |  |
| recorded_by_staff_id | uuid | yes |
| created_at | timestamp with time zone |  |
| updated_at | timestamp with time zone |  |

**Policy `record_read`** — SELECT to paathshala_app

```sql
USING ((tenant_id = app_current_tenant_id()) AND (app_actor_has_staff_scope() OR (EXISTS ( SELECT 1
   FROM (enrollment e
     JOIN student s ON ((s.id = e.student_id)))
  WHERE ((e.id = attendance_record.enrollment_id) AND (s.person_id = app_current_person_id())))) OR (EXISTS ( SELECT 1
   FROM (enrollment e
     JOIN guardian_link gl ON ((gl.student_id = e.student_id)))
  WHERE ((e.id = attendance_record.enrollment_id) AND (gl.guardian_person_id = app_current_person_id()) AND (gl.effective_to IS NULL))))))
```

**Policy `record_staff_delete`** — DELETE to paathshala_app

```sql
USING ((tenant_id = app_current_tenant_id()) AND app_actor_has_staff_scope())
```

**Policy `record_staff_insert`** — INSERT to paathshala_app

```sql
WITH CHECK ((tenant_id = app_current_tenant_id()) AND app_actor_has_staff_scope())
```

**Policy `record_staff_update`** — UPDATE to paathshala_app

```sql
USING ((tenant_id = app_current_tenant_id()) AND app_actor_has_staff_scope())
```

```sql
WITH CHECK ((tenant_id = app_current_tenant_id()) AND app_actor_has_staff_scope())
```

### `attendance_session`

Row-level security: **enabled**, **forced** (applies to the table owner too)

| Column | Type | Null |
| --- | --- | --- |
| id | uuid |  |
| tenant_id | uuid |  |
| section_id | uuid |  |
| course_offering_id | uuid | yes |
| academic_year_id | uuid |  |
| session_date | date |  |
| period_no | smallint | yes |
| mode | text |  |
| status | text |  |
| marked_by_staff_id | uuid | yes |
| submitted_at | timestamp with time zone | yes |
| locked_at | timestamp with time zone | yes |
| locked_by_staff_id | uuid | yes |
| created_at | timestamp with time zone |  |
| updated_at | timestamp with time zone |  |

**Policy `session_read`** — SELECT to paathshala_app

```sql
USING (tenant_id = app_current_tenant_id())
```

**Policy `session_staff_delete`** — DELETE to paathshala_app

```sql
USING ((tenant_id = app_current_tenant_id()) AND app_actor_has_staff_scope())
```

**Policy `session_staff_insert`** — INSERT to paathshala_app

```sql
WITH CHECK ((tenant_id = app_current_tenant_id()) AND app_actor_has_staff_scope())
```

**Policy `session_staff_update`** — UPDATE to paathshala_app

```sql
USING ((tenant_id = app_current_tenant_id()) AND app_actor_has_staff_scope())
```

```sql
WITH CHECK ((tenant_id = app_current_tenant_id()) AND app_actor_has_staff_scope())
```

### `audit_checkpoint`

Row-level security: **enabled**, **forced** (applies to the table owner too)

| Column | Type | Null |
| --- | --- | --- |
| id | uuid |  |
| tenant_id | uuid |  |
| period_start | timestamp with time zone |  |
| period_end | timestamp with time zone |  |
| row_count | bigint |  |
| prev_digest | text | yes |
| digest | text |  |
| sealed_at | timestamp with time zone |  |

**Policy `tenant_isolation`** — ALL to paathshala_app

```sql
USING (tenant_id = app_current_tenant_id())
```

```sql
WITH CHECK (tenant_id = app_current_tenant_id())
```

### `audit_log_2026_09`

Row-level security: **enabled**, **forced** (applies to the table owner too)

| Column | Type | Null |
| --- | --- | --- |
| id | uuid |  |
| occurred_at | timestamp with time zone |  |
| tenant_id | uuid |  |
| actor_user_id | uuid | yes |
| actor_role | text | yes |
| on_behalf_of_user_id | uuid | yes |
| impersonation_id | uuid | yes |
| action | text |  |
| resource_type | text |  |
| resource_id | uuid | yes |
| classification | text |  |
| before | jsonb | yes |
| after | jsonb | yes |
| request_id | text | yes |
| ip | inet | yes |
| user_agent | text | yes |
| api_client_id | uuid | yes |
| reason | text | yes |

**Policy `auth_role_appends`** — INSERT to paathshala_auth

```sql
WITH CHECK true
```

**Policy `tenant_isolation`** — ALL to paathshala_app

```sql
USING (tenant_id = app_current_tenant_id())
```

```sql
WITH CHECK (tenant_id = app_current_tenant_id())
```

### `audit_log_2026_10`

Row-level security: **enabled**, **forced** (applies to the table owner too)

| Column | Type | Null |
| --- | --- | --- |
| id | uuid |  |
| occurred_at | timestamp with time zone |  |
| tenant_id | uuid |  |
| actor_user_id | uuid | yes |
| actor_role | text | yes |
| on_behalf_of_user_id | uuid | yes |
| impersonation_id | uuid | yes |
| action | text |  |
| resource_type | text |  |
| resource_id | uuid | yes |
| classification | text |  |
| before | jsonb | yes |
| after | jsonb | yes |
| request_id | text | yes |
| ip | inet | yes |
| user_agent | text | yes |
| api_client_id | uuid | yes |
| reason | text | yes |

**Policy `auth_role_appends`** — INSERT to paathshala_auth

```sql
WITH CHECK true
```

**Policy `tenant_isolation`** — ALL to paathshala_app

```sql
USING (tenant_id = app_current_tenant_id())
```

```sql
WITH CHECK (tenant_id = app_current_tenant_id())
```

### `audit_log_2026_11`

Row-level security: **enabled**, **forced** (applies to the table owner too)

| Column | Type | Null |
| --- | --- | --- |
| id | uuid |  |
| occurred_at | timestamp with time zone |  |
| tenant_id | uuid |  |
| actor_user_id | uuid | yes |
| actor_role | text | yes |
| on_behalf_of_user_id | uuid | yes |
| impersonation_id | uuid | yes |
| action | text |  |
| resource_type | text |  |
| resource_id | uuid | yes |
| classification | text |  |
| before | jsonb | yes |
| after | jsonb | yes |
| request_id | text | yes |
| ip | inet | yes |
| user_agent | text | yes |
| api_client_id | uuid | yes |
| reason | text | yes |

**Policy `auth_role_appends`** — INSERT to paathshala_auth

```sql
WITH CHECK true
```

**Policy `tenant_isolation`** — ALL to paathshala_app

```sql
USING (tenant_id = app_current_tenant_id())
```

```sql
WITH CHECK (tenant_id = app_current_tenant_id())
```

### `campus`

Row-level security: **enabled**, **forced** (applies to the table owner too)

| Column | Type | Null |
| --- | --- | --- |
| id | uuid |  |
| tenant_id | uuid |  |
| code | text |  |
| name | text |  |
| is_primary | boolean |  |
| status | text |  |
| created_at | timestamp with time zone |  |
| updated_at | timestamp with time zone |  |
| deleted_at | timestamp with time zone | yes |

**Policy `platform_all_tenants`** — ALL to paathshala_platform

```sql
USING true
```

```sql
WITH CHECK true
```

**Policy `tenant_isolation`** — ALL to public

```sql
USING (tenant_id = app_current_tenant_id())
```

```sql
WITH CHECK (tenant_id = app_current_tenant_id())
```

### `class_group`

Row-level security: **enabled**, **forced** (applies to the table owner too)

| Column | Type | Null |
| --- | --- | --- |
| id | uuid |  |
| tenant_id | uuid |  |
| programme_id | uuid |  |
| academic_year_id | uuid |  |
| name | text |  |
| group_kind | text |  |
| capacity | integer | yes |
| level_sequence | integer | yes |
| created_at | timestamp with time zone |  |
| updated_at | timestamp with time zone |  |
| deleted_at | timestamp with time zone | yes |

**Policy `staff_delete`** — DELETE to paathshala_app

```sql
USING ((tenant_id = app_current_tenant_id()) AND app_actor_has_staff_scope())
```

**Policy `staff_insert`** — INSERT to paathshala_app

```sql
WITH CHECK ((tenant_id = app_current_tenant_id()) AND app_actor_has_staff_scope())
```

**Policy `staff_update`** — UPDATE to paathshala_app

```sql
USING ((tenant_id = app_current_tenant_id()) AND app_actor_has_staff_scope())
```

```sql
WITH CHECK ((tenant_id = app_current_tenant_id()) AND app_actor_has_staff_scope())
```

**Policy `tenant_read`** — SELECT to paathshala_app

```sql
USING (tenant_id = app_current_tenant_id())
```

### `communication_preference`

Row-level security: **enabled**, **forced** (applies to the table owner too)

| Column | Type | Null |
| --- | --- | --- |
| id | uuid |  |
| tenant_id | uuid |  |
| person_id | uuid |  |
| purpose | text |  |
| preferred_channel | text | yes |
| locale | text | yes |
| quiet_from | time without time zone | yes |
| quiet_to | time without time zone | yes |
| muted | boolean |  |
| created_at | timestamp with time zone |  |
| updated_at | timestamp with time zone |  |

**Policy `preference_own`** — ALL to paathshala_app

```sql
USING ((tenant_id = app_current_tenant_id()) AND (app_actor_has_staff_scope() OR (person_id = app_current_person_id())))
```

```sql
WITH CHECK ((tenant_id = app_current_tenant_id()) AND (app_actor_has_staff_scope() OR (person_id = app_current_person_id())))
```

### `concession`

Row-level security: **enabled**, **forced** (applies to the table owner too)

| Column | Type | Null |
| --- | --- | --- |
| id | uuid |  |
| tenant_id | uuid |  |
| fee_assignment_id | uuid |  |
| fee_component_id | uuid | yes |
| concession_type | text |  |
| mode | text |  |
| value | numeric |  |
| reason | text |  |
| requested_by | uuid | yes |
| approved_by | uuid | yes |
| approved_at | timestamp with time zone | yes |
| revoked_at | timestamp with time zone | yes |
| revoked_reason | text | yes |
| created_at | timestamp with time zone |  |

**Policy `finance_only`** — ALL to paathshala_app

```sql
USING ((tenant_id = app_current_tenant_id()) AND app_actor_has_finance_scope())
```

```sql
WITH CHECK ((tenant_id = app_current_tenant_id()) AND app_actor_has_finance_scope())
```

### `consent_record`

Row-level security: **enabled**, **forced** (applies to the table owner too)

| Column | Type | Null |
| --- | --- | --- |
| id | uuid |  |
| tenant_id | uuid |  |
| person_id | uuid |  |
| given_by_person_id | uuid |  |
| guardian_link_id | uuid | yes |
| purpose | text |  |
| basis | text |  |
| notice_version_id | uuid |  |
| channel | text |  |
| evidence_ref | text | yes |
| given_at | timestamp with time zone |  |
| withdrawn_at | timestamp with time zone | yes |
| withdrawn_reason | text | yes |
| created_at | timestamp with time zone |  |

**Policy `consent_scope`** — ALL to paathshala_app

```sql
USING ((tenant_id = app_current_tenant_id()) AND (app_actor_has_staff_scope() OR (person_id = app_current_person_id()) OR (given_by_person_id = app_current_person_id()) OR (EXISTS ( SELECT 1
   FROM (guardian_link gl
     JOIN student s ON ((s.id = gl.student_id)))
  WHERE ((s.person_id = consent_record.person_id) AND (gl.guardian_person_id = app_current_person_id()) AND (gl.effective_to IS NULL))))))
```

```sql
WITH CHECK ((tenant_id = app_current_tenant_id()) AND (app_actor_has_staff_scope() OR (given_by_person_id = app_current_person_id())))
```

### `contact_method`

Row-level security: **enabled**, **forced** (applies to the table owner too)

| Column | Type | Null |
| --- | --- | --- |
| id | uuid |  |
| tenant_id | uuid |  |
| person_id | uuid |  |
| kind | text |  |
| value | text |  |
| is_primary | boolean |  |
| verified_at | timestamp with time zone | yes |
| opt_in_state | text |  |
| created_at | timestamp with time zone |  |
| updated_at | timestamp with time zone |  |
| deleted_at | timestamp with time zone | yes |

**Policy `tenant_isolation`** — ALL to paathshala_app

```sql
USING (tenant_id = app_current_tenant_id())
```

```sql
WITH CHECK (tenant_id = app_current_tenant_id())
```

### `course_offering`

Row-level security: **enabled**, **forced** (applies to the table owner too)

| Column | Type | Null |
| --- | --- | --- |
| id | uuid |  |
| tenant_id | uuid |  |
| class_group_id | uuid |  |
| section_id | uuid | yes |
| subject_id | uuid |  |
| term_id | uuid |  |
| primary_teacher_staff_id | uuid | yes |
| credits | numeric | yes |
| is_elective | boolean |  |
| created_at | timestamp with time zone |  |
| updated_at | timestamp with time zone |  |
| deleted_at | timestamp with time zone | yes |

**Policy `staff_delete`** — DELETE to paathshala_app

```sql
USING ((tenant_id = app_current_tenant_id()) AND app_actor_has_staff_scope())
```

**Policy `staff_insert`** — INSERT to paathshala_app

```sql
WITH CHECK ((tenant_id = app_current_tenant_id()) AND app_actor_has_staff_scope())
```

**Policy `staff_update`** — UPDATE to paathshala_app

```sql
USING ((tenant_id = app_current_tenant_id()) AND app_actor_has_staff_scope())
```

```sql
WITH CHECK ((tenant_id = app_current_tenant_id()) AND app_actor_has_staff_scope())
```

**Policy `tenant_read`** — SELECT to paathshala_app

```sql
USING (tenant_id = app_current_tenant_id())
```

### `delivery_receipt`

Row-level security: **enabled**, **forced** (applies to the table owner too)

| Column | Type | Null |
| --- | --- | --- |
| id | uuid |  |
| tenant_id | uuid |  |
| provider | text |  |
| provider_message_id | text |  |
| provider_event_id | text | yes |
| status | text |  |
| error_code | text | yes |
| raw_body | text |  |
| signature_valid | boolean | yes |
| received_at | timestamp with time zone |  |
| processed_at | timestamp with time zone | yes |

**Policy `staff_only`** — ALL to paathshala_app

```sql
USING ((tenant_id = app_current_tenant_id()) AND app_actor_has_staff_scope())
```

```sql
WITH CHECK ((tenant_id = app_current_tenant_id()) AND app_actor_has_staff_scope())
```

### `device`

Row-level security: **enabled**, **forced** (applies to the table owner too)

| Column | Type | Null |
| --- | --- | --- |
| id | uuid |  |
| user_account_id | uuid |  |
| platform | text |  |
| app_version | text | yes |
| push_token | text | yes |
| fingerprint | text |  |
| trusted_at | timestamp with time zone | yes |
| created_at | timestamp with time zone |  |
| updated_at | timestamp with time zone |  |

**Policy `auth_role_full_access`** — ALL to paathshala_auth

```sql
USING true
```

```sql
WITH CHECK true
```

### `enquiry`

Row-level security: **enabled**, **forced** (applies to the table owner too)

| Column | Type | Null |
| --- | --- | --- |
| id | uuid |  |
| tenant_id | uuid |  |
| lead_id | uuid |  |
| programme_id | uuid |  |
| academic_year_id | uuid |  |
| stage | text |  |
| next_action_at | timestamp with time zone | yes |
| next_action_note | text | yes |
| lost_reason | text | yes |
| form_submission_id | uuid | yes |
| created_at | timestamp with time zone |  |
| updated_at | timestamp with time zone |  |
| deleted_at | timestamp with time zone | yes |

**Policy `staff_only`** — ALL to paathshala_app

```sql
USING ((tenant_id = app_current_tenant_id()) AND app_actor_has_staff_scope())
```

```sql
WITH CHECK ((tenant_id = app_current_tenant_id()) AND app_actor_has_staff_scope())
```

### `enrollment`

Row-level security: **enabled**, **forced** (applies to the table owner too)

| Column | Type | Null |
| --- | --- | --- |
| id | uuid |  |
| tenant_id | uuid |  |
| student_id | uuid |  |
| section_id | uuid |  |
| academic_year_id | uuid |  |
| admission_decision_id | uuid | yes |
| status | text |  |
| roll_no | text | yes |
| enrolled_on | date |  |
| ended_on | date | yes |
| created_at | timestamp with time zone |  |
| updated_at | timestamp with time zone |  |

**Policy `enrollment_office_delete`** — DELETE to paathshala_app

```sql
USING ((tenant_id = app_current_tenant_id()) AND app_actor_has_whole_school_scope())
```

**Policy `enrollment_office_insert`** — INSERT to paathshala_app

```sql
WITH CHECK ((tenant_id = app_current_tenant_id()) AND app_actor_has_whole_school_scope())
```

**Policy `enrollment_office_update`** — UPDATE to paathshala_app

```sql
USING ((tenant_id = app_current_tenant_id()) AND app_actor_has_whole_school_scope())
```

```sql
WITH CHECK ((tenant_id = app_current_tenant_id()) AND app_actor_has_whole_school_scope())
```

**Policy `enrollment_read`** — SELECT to paathshala_app

```sql
USING ((tenant_id = app_current_tenant_id()) AND (app_actor_has_whole_school_scope() OR (section_id = ANY (app_actor_section_ids())) OR (EXISTS ( SELECT 1
   FROM student s
  WHERE ((s.id = enrollment.student_id) AND (s.person_id = app_current_person_id())))) OR (EXISTS ( SELECT 1
   FROM guardian_link gl
  WHERE ((gl.student_id = enrollment.student_id) AND (gl.guardian_person_id = app_current_person_id()) AND (gl.effective_to IS NULL))))))
```

### `enrollment_event`

Row-level security: **enabled**, **forced** (applies to the table owner too)

| Column | Type | Null |
| --- | --- | --- |
| id | uuid |  |
| tenant_id | uuid |  |
| enrollment_id | uuid |  |
| event_type | text |  |
| effective_on | date |  |
| reason | text | yes |
| actor_user_id | uuid | yes |
| related_enrollment_id | uuid | yes |
| from_section_id | uuid | yes |
| to_section_id | uuid | yes |
| created_at | timestamp with time zone |  |

**Policy `staff_only`** — ALL to paathshala_app

```sql
USING ((tenant_id = app_current_tenant_id()) AND app_actor_has_staff_scope())
```

```sql
WITH CHECK ((tenant_id = app_current_tenant_id()) AND app_actor_has_staff_scope())
```

### `fee_assignment`

Row-level security: **enabled**, **forced** (applies to the table owner too)

| Column | Type | Null |
| --- | --- | --- |
| id | uuid |  |
| tenant_id | uuid |  |
| enrollment_id | uuid |  |
| fee_plan_id | uuid |  |
| effective_from | date |  |
| effective_to | date | yes |
| override_reason | text | yes |
| created_at | timestamp with time zone |  |
| updated_at | timestamp with time zone |  |

**Policy `finance_only`** — ALL to paathshala_app

```sql
USING ((tenant_id = app_current_tenant_id()) AND app_actor_has_finance_scope())
```

```sql
WITH CHECK ((tenant_id = app_current_tenant_id()) AND app_actor_has_finance_scope())
```

### `fee_component`

Row-level security: **enabled**, **forced** (applies to the table owner too)

| Column | Type | Null |
| --- | --- | --- |
| id | uuid |  |
| tenant_id | uuid |  |
| fee_plan_id | uuid |  |
| code | text |  |
| name | text |  |
| amount | numeric |  |
| frequency | text |  |
| is_refundable | boolean |  |
| is_optional | boolean |  |
| tax_rate | numeric |  |
| gl_code | text | yes |
| sort_order | integer |  |
| created_at | timestamp with time zone |  |

**Policy `finance_only`** — ALL to paathshala_app

```sql
USING ((tenant_id = app_current_tenant_id()) AND app_actor_has_finance_scope())
```

```sql
WITH CHECK ((tenant_id = app_current_tenant_id()) AND app_actor_has_finance_scope())
```

### `fee_plan`

Row-level security: **enabled**, **forced** (applies to the table owner too)

| Column | Type | Null |
| --- | --- | --- |
| id | uuid |  |
| tenant_id | uuid |  |
| academic_unit_id | uuid |  |
| programme_id | uuid | yes |
| academic_year_id | uuid |  |
| name | text |  |
| version | integer |  |
| status | text |  |
| currency | character |  |
| published_at | timestamp with time zone | yes |
| published_by | uuid | yes |
| created_at | timestamp with time zone |  |
| updated_at | timestamp with time zone |  |
| deleted_at | timestamp with time zone | yes |

**Policy `finance_only`** — ALL to paathshala_app

```sql
USING ((tenant_id = app_current_tenant_id()) AND app_actor_has_finance_scope())
```

```sql
WITH CHECK ((tenant_id = app_current_tenant_id()) AND app_actor_has_finance_scope())
```

### `file`

Row-level security: **enabled**, **forced** (applies to the table owner too)

| Column | Type | Null |
| --- | --- | --- |
| id | uuid |  |
| tenant_id | uuid |  |
| bucket | text |  |
| object_key | text |  |
| mime_type | text |  |
| size_bytes | bigint |  |
| sha256 | text |  |
| classification | text |  |
| uploaded_by | uuid | yes |
| virus_scan_state | text |  |
| legal_hold | boolean |  |
| created_at | timestamp with time zone |  |
| deleted_at | timestamp with time zone | yes |

**Policy `staff_only`** — ALL to paathshala_app

```sql
USING ((tenant_id = app_current_tenant_id()) AND app_actor_has_staff_scope())
```

```sql
WITH CHECK ((tenant_id = app_current_tenant_id()) AND app_actor_has_staff_scope())
```

### `form_definition`

Row-level security: **enabled**, **forced** (applies to the table owner too)

| Column | Type | Null |
| --- | --- | --- |
| id | uuid |  |
| tenant_id | uuid |  |
| code | text |  |
| version | integer |  |
| title | text |  |
| purpose | text |  |
| json_schema | jsonb |  |
| ui_schema | jsonb | yes |
| published_at | timestamp with time zone | yes |
| created_by | uuid | yes |
| created_at | timestamp with time zone |  |
| updated_at | timestamp with time zone |  |

**Policy `staff_only`** — ALL to paathshala_app

```sql
USING ((tenant_id = app_current_tenant_id()) AND app_actor_has_staff_scope())
```

```sql
WITH CHECK ((tenant_id = app_current_tenant_id()) AND app_actor_has_staff_scope())
```

### `form_submission`

Row-level security: **enabled**, **forced** (applies to the table owner too)

| Column | Type | Null |
| --- | --- | --- |
| id | uuid |  |
| tenant_id | uuid |  |
| form_definition_id | uuid |  |
| payload | jsonb |  |
| submitted_by | uuid | yes |
| submitted_at | timestamp with time zone |  |

**Policy `staff_only`** — ALL to paathshala_app

```sql
USING ((tenant_id = app_current_tenant_id()) AND app_actor_has_staff_scope())
```

```sql
WITH CHECK ((tenant_id = app_current_tenant_id()) AND app_actor_has_staff_scope())
```

### `grade_band`

Row-level security: **enabled**, **forced** (applies to the table owner too)

| Column | Type | Null |
| --- | --- | --- |
| id | uuid |  |
| tenant_id | uuid |  |
| grading_scale_id | uuid |  |
| label | text |  |
| span | numrange |  |
| grade_point | numeric | yes |
| is_pass | boolean |  |
| description | text | yes |
| created_at | timestamp with time zone |  |

**Policy `structure_read`** — SELECT to paathshala_app

```sql
USING (tenant_id = app_current_tenant_id())
```

**Policy `structure_staff_write`** — ALL to paathshala_app

```sql
USING ((tenant_id = app_current_tenant_id()) AND app_actor_has_staff_scope())
```

```sql
WITH CHECK ((tenant_id = app_current_tenant_id()) AND app_actor_has_staff_scope())
```

### `grading_scale`

Row-level security: **enabled**, **forced** (applies to the table owner too)

| Column | Type | Null |
| --- | --- | --- |
| id | uuid |  |
| tenant_id | uuid |  |
| academic_unit_id | uuid |  |
| name | text |  |
| kind | text |  |
| is_published | boolean |  |
| published_at | timestamp with time zone | yes |
| published_by | uuid | yes |
| created_at | timestamp with time zone |  |
| updated_at | timestamp with time zone |  |
| deleted_at | timestamp with time zone | yes |

**Policy `structure_read`** — SELECT to paathshala_app

```sql
USING (tenant_id = app_current_tenant_id())
```

**Policy `structure_staff_write`** — ALL to paathshala_app

```sql
USING ((tenant_id = app_current_tenant_id()) AND app_actor_has_staff_scope())
```

```sql
WITH CHECK ((tenant_id = app_current_tenant_id()) AND app_actor_has_staff_scope())
```

### `guardian_link`

Row-level security: **enabled**, **forced** (applies to the table owner too)

| Column | Type | Null |
| --- | --- | --- |
| id | uuid |  |
| tenant_id | uuid |  |
| student_id | uuid |  |
| guardian_person_id | uuid |  |
| relationship | text |  |
| is_primary | boolean |  |
| can_view_academics | boolean |  |
| can_view_finance | boolean |  |
| can_pay | boolean |  |
| can_authorise_pickup | boolean |  |
| can_receive_notifications | boolean |  |
| legal_custody_note | text | yes |
| effective_from | date |  |
| effective_to | date | yes |
| created_at | timestamp with time zone |  |
| updated_at | timestamp with time zone |  |

Column-level grants (narrower than the table):

- `paathshala_health` may **select** only: `id`, `can_view_academics`, `effective_to`, `tenant_id`, `student_id`, `effective_from`, `guardian_person_id`, `can_view_finance`

**Policy `guardian_scope`** — ALL to paathshala_app

```sql
USING ((tenant_id = app_current_tenant_id()) AND (app_actor_has_staff_scope() OR (guardian_person_id = app_current_person_id())))
```

```sql
WITH CHECK ((tenant_id = app_current_tenant_id()) AND app_actor_has_staff_scope())
```

**Policy `health_scope`** — SELECT to paathshala_health

```sql
USING (tenant_id = app_current_tenant_id())
```

### `idempotency_key`

Row-level security: **enabled**, **forced** (applies to the table owner too)

| Column | Type | Null |
| --- | --- | --- |
| id | uuid |  |
| tenant_id | uuid |  |
| api_client_id | uuid |  |
| idem_key | text |  |
| request_digest | text |  |
| endpoint | text |  |
| state | text |  |
| status_code | integer | yes |
| response_body | jsonb | yes |
| created_at | timestamp with time zone |  |
| completed_at | timestamp with time zone | yes |
| expires_at | timestamp with time zone |  |

**Policy `tenant_isolation`** — ALL to paathshala_app

```sql
USING (tenant_id = app_current_tenant_id())
```

```sql
WITH CHECK (tenant_id = app_current_tenant_id())
```

### `impersonation_session`

Row-level security: **enabled**, **forced** (applies to the table owner too)

| Column | Type | Null |
| --- | --- | --- |
| id | uuid |  |
| tenant_id | uuid |  |
| actor_user_id | uuid |  |
| target_user_id | uuid | yes |
| reason | text |  |
| ticket_ref | text |  |
| status | text |  |
| write_enabled | boolean |  |
| requested_at | timestamp with time zone |  |
| approved_by | uuid | yes |
| approved_at | timestamp with time zone | yes |
| denied_by | uuid | yes |
| denied_at | timestamp with time zone | yes |
| started_at | timestamp with time zone | yes |
| expires_at | timestamp with time zone | yes |
| revoked_at | timestamp with time zone | yes |
| revoked_by | uuid | yes |
| revoked_reason | text | yes |

**Policy `tenant_isolation`** — ALL to paathshala_app

```sql
USING (tenant_id = app_current_tenant_id())
```

```sql
WITH CHECK (tenant_id = app_current_tenant_id())
```

### `import_applied_row`

Row-level security: **enabled**, **forced** (applies to the table owner too)

| Column | Type | Null |
| --- | --- | --- |
| id | uuid |  |
| tenant_id | uuid |  |
| import_batch_id | uuid |  |
| import_row_id | uuid | yes |
| target_table | text |  |
| target_id | uuid |  |
| action | text |  |
| before_values | jsonb | yes |
| sequence_no | integer |  |
| reversed_at | timestamp with time zone | yes |
| created_at | timestamp with time zone |  |

**Policy `staff_only`** — ALL to paathshala_app

```sql
USING ((tenant_id = app_current_tenant_id()) AND app_actor_has_staff_scope())
```

```sql
WITH CHECK ((tenant_id = app_current_tenant_id()) AND app_actor_has_staff_scope())
```

### `import_batch`

Row-level security: **enabled**, **forced** (applies to the table owner too)

| Column | Type | Null |
| --- | --- | --- |
| id | uuid |  |
| tenant_id | uuid |  |
| campus_id | uuid | yes |
| entity | text |  |
| file_id | uuid | yes |
| original_filename | text | yes |
| source_sha256 | text | yes |
| status | text |  |
| plan_digest | text | yes |
| preview_counts | jsonb | yes |
| applied_counts | jsonb | yes |
| uploaded_by | uuid | yes |
| applied_by | uuid | yes |
| reversed_by | uuid | yes |
| reverse_reason | text | yes |
| created_at | timestamp with time zone |  |
| validated_at | timestamp with time zone | yes |
| previewed_at | timestamp with time zone | yes |
| applied_at | timestamp with time zone | yes |
| reversed_at | timestamp with time zone | yes |

**Policy `staff_only`** — ALL to paathshala_app

```sql
USING ((tenant_id = app_current_tenant_id()) AND app_actor_has_staff_scope())
```

```sql
WITH CHECK ((tenant_id = app_current_tenant_id()) AND app_actor_has_staff_scope())
```

### `import_mapping`

Row-level security: **enabled**, **forced** (applies to the table owner too)

| Column | Type | Null |
| --- | --- | --- |
| id | uuid |  |
| tenant_id | uuid |  |
| import_batch_id | uuid |  |
| source_column | text |  |
| target_field | text |  |
| transform | text | yes |
| is_required | boolean |  |
| default_value | text | yes |
| created_at | timestamp with time zone |  |

**Policy `staff_only`** — ALL to paathshala_app

```sql
USING ((tenant_id = app_current_tenant_id()) AND app_actor_has_staff_scope())
```

```sql
WITH CHECK ((tenant_id = app_current_tenant_id()) AND app_actor_has_staff_scope())
```

### `import_row`

Row-level security: **enabled**, **forced** (applies to the table owner too)

| Column | Type | Null |
| --- | --- | --- |
| id | uuid |  |
| tenant_id | uuid |  |
| import_batch_id | uuid |  |
| row_no | integer |  |
| raw | jsonb |  |
| normalised | jsonb | yes |
| status | text |  |
| errors | jsonb |  |
| planned_action | text | yes |
| matched_id | uuid | yes |
| created_at | timestamp with time zone |  |
| updated_at | timestamp with time zone |  |

**Policy `staff_only`** — ALL to paathshala_app

```sql
USING ((tenant_id = app_current_tenant_id()) AND app_actor_has_staff_scope())
```

```sql
WITH CHECK ((tenant_id = app_current_tenant_id()) AND app_actor_has_staff_scope())
```

### `installment`

Row-level security: **enabled**, **forced** (applies to the table owner too)

| Column | Type | Null |
| --- | --- | --- |
| id | uuid |  |
| tenant_id | uuid |  |
| fee_assignment_id | uuid |  |
| sequence | integer |  |
| due_on | date |  |
| gross_amount | numeric |  |
| concession_amount | numeric |  |
| net_amount | numeric |  |
| status | text |  |
| created_at | timestamp with time zone |  |
| updated_at | timestamp with time zone |  |

**Policy `finance_only`** — ALL to paathshala_app

```sql
USING ((tenant_id = app_current_tenant_id()) AND app_actor_has_finance_scope())
```

```sql
WITH CHECK ((tenant_id = app_current_tenant_id()) AND app_actor_has_finance_scope())
```

### `invoice`

Row-level security: **enabled**, **forced** (applies to the table owner too)

| Column | Type | Null |
| --- | --- | --- |
| id | uuid |  |
| tenant_id | uuid |  |
| campus_id | uuid |  |
| installment_id | uuid | yes |
| enrollment_id | uuid |  |
| invoice_no | text |  |
| financial_year | text |  |
| issued_on | date |  |
| due_on | date |  |
| subtotal | numeric |  |
| discount_total | numeric |  |
| tax_total | numeric |  |
| total | numeric |  |
| amount_paid | numeric |  |
| status | text |  |
| voided_by | uuid | yes |
| voided_at | timestamp with time zone | yes |
| void_reason | text | yes |
| created_at | timestamp with time zone |  |
| updated_at | timestamp with time zone |  |

**Policy `invoice_finance_write`** — ALL to paathshala_app

```sql
USING ((tenant_id = app_current_tenant_id()) AND app_actor_has_finance_scope())
```

```sql
WITH CHECK ((tenant_id = app_current_tenant_id()) AND app_actor_has_finance_scope())
```

**Policy `invoice_read`** — SELECT to paathshala_app

```sql
USING ((tenant_id = app_current_tenant_id()) AND (app_actor_has_finance_scope() OR (EXISTS ( SELECT 1
   FROM (enrollment e
     JOIN student s ON ((s.id = e.student_id)))
  WHERE ((e.id = invoice.enrollment_id) AND (s.person_id = app_current_person_id())))) OR (EXISTS ( SELECT 1
   FROM (enrollment e
     JOIN guardian_link gl ON ((gl.student_id = e.student_id)))
  WHERE ((e.id = invoice.enrollment_id) AND (gl.guardian_person_id = app_current_person_id()) AND (gl.effective_to IS NULL) AND gl.can_view_finance)))))
```

### `invoice_line`

Row-level security: **enabled**, **forced** (applies to the table owner too)

| Column | Type | Null |
| --- | --- | --- |
| id | uuid |  |
| tenant_id | uuid |  |
| invoice_id | uuid |  |
| fee_component_id | uuid | yes |
| description | text |  |
| quantity | numeric |  |
| unit_amount | numeric |  |
| discount_amount | numeric |  |
| tax_rate | numeric |  |
| tax_amount | numeric |  |
| line_total | numeric |  |
| gl_code | text | yes |
| created_at | timestamp with time zone |  |

**Policy `finance_only`** — ALL to paathshala_app

```sql
USING ((tenant_id = app_current_tenant_id()) AND app_actor_has_finance_scope())
```

```sql
WITH CHECK ((tenant_id = app_current_tenant_id()) AND app_actor_has_finance_scope())
```

### `kb_article`

Row-level security: **enabled**, **forced** (applies to the table owner too)

| Column | Type | Null |
| --- | --- | --- |
| id | uuid |  |
| tenant_id | uuid |  |
| slug | text |  |
| title | text |  |
| audience | text |  |
| category | text | yes |
| status | text |  |
| published_version | integer | yes |
| created_by | uuid | yes |
| created_at | timestamp with time zone |  |
| updated_at | timestamp with time zone |  |

**Policy `read_published_write_staff`** — ALL to paathshala_app

```sql
USING ((tenant_id = app_current_tenant_id()) AND (app_actor_has_staff_scope() OR ((status = 'published'::text) AND (audience = ANY (ARRAY['everyone'::text, 'guardians'::text])))))
```

```sql
WITH CHECK ((tenant_id = app_current_tenant_id()) AND app_actor_has_staff_scope())
```

### `kb_article_version`

Row-level security: **enabled**, **forced** (applies to the table owner too)

| Column | Type | Null |
| --- | --- | --- |
| id | uuid |  |
| tenant_id | uuid |  |
| kb_article_id | uuid |  |
| version | integer |  |
| title | text |  |
| body | text |  |
| written_by | uuid | yes |
| created_at | timestamp with time zone |  |

**Policy `read_published_write_staff`** — ALL to paathshala_app

```sql
USING ((tenant_id = app_current_tenant_id()) AND (EXISTS ( SELECT 1
   FROM kb_article a
  WHERE ((a.id = kb_article_version.kb_article_id) AND (app_actor_has_staff_scope() OR ((a.status = 'published'::text) AND (a.published_version = kb_article_version.version) AND (a.audience = ANY (ARRAY['everyone'::text, 'guardians'::text]))))))))
```

```sql
WITH CHECK ((tenant_id = app_current_tenant_id()) AND app_actor_has_staff_scope())
```

### `lead`

Row-level security: **enabled**, **forced** (applies to the table owner too)

| Column | Type | Null |
| --- | --- | --- |
| id | uuid |  |
| tenant_id | uuid |  |
| campus_id | uuid |  |
| source | text |  |
| name | text |  |
| phone | text | yes |
| email | USER-DEFINED | yes |
| utm | jsonb | yes |
| score | integer | yes |
| owner_staff_id | uuid | yes |
| status | text |  |
| created_at | timestamp with time zone |  |
| updated_at | timestamp with time zone |  |
| deleted_at | timestamp with time zone | yes |

**Policy `staff_only`** — ALL to paathshala_app

```sql
USING ((tenant_id = app_current_tenant_id()) AND app_actor_has_staff_scope())
```

```sql
WITH CHECK ((tenant_id = app_current_tenant_id()) AND app_actor_has_staff_scope())
```

### `leave_request`

Row-level security: **enabled**, **forced** (applies to the table owner too)

| Column | Type | Null |
| --- | --- | --- |
| id | uuid |  |
| tenant_id | uuid |  |
| subject_type | text |  |
| student_id | uuid | yes |
| staff_id | uuid | yes |
| from_date | date |  |
| to_date | date |  |
| leave_type | text |  |
| reason | text |  |
| attachment_file_id | uuid | yes |
| status | text |  |
| requested_by | uuid | yes |
| decided_by | uuid | yes |
| decided_at | timestamp with time zone | yes |
| decision_note | text | yes |
| created_at | timestamp with time zone |  |
| updated_at | timestamp with time zone |  |

**Policy `leave_insert`** — INSERT to paathshala_app

```sql
WITH CHECK ((tenant_id = app_current_tenant_id()) AND (app_actor_has_staff_scope() OR (EXISTS ( SELECT 1
   FROM guardian_link gl
  WHERE ((gl.student_id = leave_request.student_id) AND (gl.guardian_person_id = app_current_person_id()) AND (gl.effective_to IS NULL))))))
```

**Policy `leave_read`** — SELECT to paathshala_app

```sql
USING ((tenant_id = app_current_tenant_id()) AND (app_actor_has_staff_scope() OR (EXISTS ( SELECT 1
   FROM student s
  WHERE ((s.id = leave_request.student_id) AND (s.person_id = app_current_person_id())))) OR (EXISTS ( SELECT 1
   FROM guardian_link gl
  WHERE ((gl.student_id = leave_request.student_id) AND (gl.guardian_person_id = app_current_person_id()) AND (gl.effective_to IS NULL))))))
```

**Policy `leave_staff_update`** — UPDATE to paathshala_app

```sql
USING ((tenant_id = app_current_tenant_id()) AND app_actor_has_staff_scope())
```

```sql
WITH CHECK ((tenant_id = app_current_tenant_id()) AND app_actor_has_staff_scope())
```

### `ledger_entry`

Row-level security: **enabled**, **forced** (applies to the table owner too)

| Column | Type | Null |
| --- | --- | --- |
| id | uuid |  |
| tenant_id | uuid |  |
| campus_id | uuid | yes |
| entry_group_id | uuid |  |
| account_code | text |  |
| debit | numeric |  |
| credit | numeric |  |
| currency | character |  |
| occurred_on | date |  |
| source_type | text |  |
| source_id | uuid | yes |
| narration | text | yes |
| created_at | timestamp with time zone |  |

**Policy `finance_only`** — ALL to paathshala_app

```sql
USING ((tenant_id = app_current_tenant_id()) AND app_actor_has_finance_scope())
```

```sql
WITH CHECK ((tenant_id = app_current_tenant_id()) AND app_actor_has_finance_scope())
```

### `mandate`

Row-level security: **enabled**, **forced** (applies to the table owner too)

| Column | Type | Null |
| --- | --- | --- |
| id | uuid |  |
| tenant_id | uuid |  |
| payer_person_id | uuid |  |
| provider | text |  |
| provider_mandate_id | text |  |
| max_amount | numeric |  |
| frequency | text |  |
| valid_from | date |  |
| valid_to | date | yes |
| status | text |  |
| authorised_at | timestamp with time zone | yes |
| revoked_at | timestamp with time zone | yes |
| failure_reason | text | yes |
| created_at | timestamp with time zone |  |
| updated_at | timestamp with time zone |  |

**Policy `finance_only`** — ALL to paathshala_app

```sql
USING ((tenant_id = app_current_tenant_id()) AND app_actor_has_finance_scope())
```

```sql
WITH CHECK ((tenant_id = app_current_tenant_id()) AND app_actor_has_finance_scope())
```

### `mark`

Row-level security: **enabled**, **forced** (applies to the table owner too)

| Column | Type | Null |
| --- | --- | --- |
| id | uuid |  |
| tenant_id | uuid |  |
| assessment_id | uuid |  |
| enrollment_id | uuid |  |
| marks_obtained | numeric | yes |
| is_absent | boolean |  |
| is_exempt | boolean |  |
| remarks | text | yes |
| source | text |  |
| client_event_id | uuid | yes |
| entered_by_staff_id | uuid | yes |
| entered_at | timestamp with time zone |  |
| created_at | timestamp with time zone |  |
| updated_at | timestamp with time zone |  |

**Policy `mark_staff_only`** — ALL to paathshala_app

```sql
USING ((tenant_id = app_current_tenant_id()) AND app_actor_has_staff_scope())
```

```sql
WITH CHECK ((tenant_id = app_current_tenant_id()) AND app_actor_has_staff_scope())
```

### `mark_correction`

Row-level security: **enabled**, **forced** (applies to the table owner too)

| Column | Type | Null |
| --- | --- | --- |
| id | uuid |  |
| tenant_id | uuid |  |
| mark_id | uuid | yes |
| assessment_id | uuid | yes |
| enrollment_id | uuid | yes |
| from_marks | numeric | yes |
| from_absent | boolean | yes |
| to_marks | numeric | yes |
| to_absent | boolean |  |
| to_exempt | boolean |  |
| reason | text |  |
| status | text |  |
| requested_by | uuid | yes |
| requested_at | timestamp with time zone |  |
| approved_by | uuid | yes |
| approved_at | timestamp with time zone | yes |
| rejection_reason | text | yes |
| created_at | timestamp with time zone |  |

**Policy `mark_correction_staff_only`** — ALL to paathshala_app

```sql
USING ((tenant_id = app_current_tenant_id()) AND app_actor_has_staff_scope())
```

```sql
WITH CHECK ((tenant_id = app_current_tenant_id()) AND app_actor_has_staff_scope())
```

### `message_attempt`

Row-level security: **enabled**, **forced** (applies to the table owner too)

| Column | Type | Null |
| --- | --- | --- |
| id | uuid |  |
| tenant_id | uuid |  |
| message_recipient_id | uuid |  |
| attempt_no | integer |  |
| channel | text |  |
| fallback_from | text | yes |
| provider | text | yes |
| provider_message_id | text | yes |
| provider_status | text | yes |
| error_code | text | yes |
| error_detail | text | yes |
| sent_at | timestamp with time zone |  |

**Policy `staff_only`** — ALL to paathshala_app

```sql
USING ((tenant_id = app_current_tenant_id()) AND app_actor_has_staff_scope())
```

```sql
WITH CHECK ((tenant_id = app_current_tenant_id()) AND app_actor_has_staff_scope())
```

### `message_recipient`

Row-level security: **enabled**, **forced** (applies to the table owner too)

| Column | Type | Null |
| --- | --- | --- |
| id | uuid |  |
| tenant_id | uuid |  |
| message_request_id | uuid |  |
| person_id | uuid |  |
| subject_person_id | uuid | yes |
| contact_method_id | uuid | yes |
| channel | text | yes |
| locale | text | yes |
| rendered_body | text | yes |
| status | text |  |
| suppression_reason | text | yes |
| created_at | timestamp with time zone |  |
| updated_at | timestamp with time zone |  |

**Policy `recipient_read`** — SELECT to paathshala_app

```sql
USING ((tenant_id = app_current_tenant_id()) AND (app_actor_has_staff_scope() OR (person_id = app_current_person_id())))
```

**Policy `recipient_staff_write`** — ALL to paathshala_app

```sql
USING ((tenant_id = app_current_tenant_id()) AND app_actor_has_staff_scope())
```

```sql
WITH CHECK ((tenant_id = app_current_tenant_id()) AND app_actor_has_staff_scope())
```

### `message_request`

Row-level security: **enabled**, **forced** (applies to the table owner too)

| Column | Type | Null |
| --- | --- | --- |
| id | uuid |  |
| tenant_id | uuid |  |
| campus_id | uuid | yes |
| message_template_id | uuid |  |
| purpose | text |  |
| source_type | text |  |
| source_id | uuid | yes |
| idempotency_key | text |  |
| status | text |  |
| requested_by | uuid | yes |
| created_at | timestamp with time zone |  |
| completed_at | timestamp with time zone | yes |

**Policy `staff_only`** — ALL to paathshala_app

```sql
USING ((tenant_id = app_current_tenant_id()) AND app_actor_has_staff_scope())
```

```sql
WITH CHECK ((tenant_id = app_current_tenant_id()) AND app_actor_has_staff_scope())
```

### `message_template`

Row-level security: **enabled**, **forced** (applies to the table owner too)

| Column | Type | Null |
| --- | --- | --- |
| id | uuid |  |
| tenant_id | uuid |  |
| code | text |  |
| name | text |  |
| purpose | text |  |
| created_at | timestamp with time zone |  |
| updated_at | timestamp with time zone |  |
| deleted_at | timestamp with time zone | yes |

**Policy `template_read`** — SELECT to paathshala_app

```sql
USING (tenant_id = app_current_tenant_id())
```

**Policy `template_staff_write`** — ALL to paathshala_app

```sql
USING ((tenant_id = app_current_tenant_id()) AND app_actor_has_staff_scope())
```

```sql
WITH CHECK ((tenant_id = app_current_tenant_id()) AND app_actor_has_staff_scope())
```

### `message_template_version`

Row-level security: **enabled**, **forced** (applies to the table owner too)

| Column | Type | Null |
| --- | --- | --- |
| id | uuid |  |
| tenant_id | uuid |  |
| message_template_id | uuid |  |
| channel | text |  |
| locale | text |  |
| version | integer |  |
| body | text |  |
| variables | ARRAY |  |
| dlt_entity_id | text | yes |
| dlt_template_id | text | yes |
| sender_header | text | yes |
| wa_template_name | text | yes |
| wa_language | text | yes |
| approval_status | text |  |
| approved_at | timestamp with time zone | yes |
| rejection_reason | text | yes |
| created_at | timestamp with time zone |  |
| updated_at | timestamp with time zone |  |

**Policy `template_read`** — SELECT to paathshala_app

```sql
USING (tenant_id = app_current_tenant_id())
```

**Policy `template_staff_write`** — ALL to paathshala_app

```sql
USING ((tenant_id = app_current_tenant_id()) AND app_actor_has_staff_scope())
```

```sql
WITH CHECK ((tenant_id = app_current_tenant_id()) AND app_actor_has_staff_scope())
```

### `notice_version`

Row-level security: **enabled**, **forced** (applies to the table owner too)

| Column | Type | Null |
| --- | --- | --- |
| id | uuid |  |
| tenant_id | uuid | yes |
| code | text |  |
| version | integer |  |
| locale | text |  |
| title | text |  |
| body | text |  |
| published_at | timestamp with time zone | yes |
| created_at | timestamp with time zone |  |

**Policy `notice_visibility`** — SELECT to paathshala_app

```sql
USING ((tenant_id IS NULL) OR (tenant_id = app_current_tenant_id()))
```

### `organization`

Row-level security: **enabled**, **forced** (applies to the table owner too)

| Column | Type | Null |
| --- | --- | --- |
| id | uuid |  |
| legal_name | text |  |
| display_name | text |  |
| gstin | text | yes |
| pan | text | yes |
| country | character |  |
| timezone | text |  |
| locale | text |  |
| status | text |  |
| created_at | timestamp with time zone |  |
| updated_at | timestamp with time zone |  |
| deleted_at | timestamp with time zone | yes |

**Policy `platform_all_tenants`** — ALL to paathshala_platform

```sql
USING true
```

```sql
WITH CHECK true
```

**Policy `tenant_isolation`** — ALL to public

```sql
USING (id = app_current_tenant_id())
```

```sql
WITH CHECK (id = app_current_tenant_id())
```

### `outbox_event`

Row-level security: **enabled**, **forced** (applies to the table owner too)

| Column | Type | Null |
| --- | --- | --- |
| id | uuid |  |
| tenant_id | uuid |  |
| event_type | text |  |
| aggregate_type | text |  |
| aggregate_id | uuid | yes |
| schema_version | text |  |
| payload | jsonb |  |
| occurred_at | timestamp with time zone |  |
| published_at | timestamp with time zone | yes |
| attempts | integer |  |
| last_error | text | yes |

**Policy `tenant_isolation`** — ALL to paathshala_app

```sql
USING (tenant_id = app_current_tenant_id())
```

```sql
WITH CHECK (tenant_id = app_current_tenant_id())
```

### `payment`

Row-level security: **enabled**, **forced** (applies to the table owner too)

| Column | Type | Null |
| --- | --- | --- |
| id | uuid |  |
| tenant_id | uuid |  |
| campus_id | uuid |  |
| payer_person_id | uuid | yes |
| method | text |  |
| amount | numeric |  |
| currency | character |  |
| received_on | date |  |
| status | text |  |
| provider | text | yes |
| provider_order_id | text | yes |
| provider_payment_id | text | yes |
| mandate_id | uuid | yes |
| idempotency_key | text |  |
| instrument_last4 | character | yes |
| instrument_network | text | yes |
| created_at | timestamp with time zone |  |
| updated_at | timestamp with time zone |  |
| target_invoice_id | uuid | yes |

**Policy `payment_finance_write`** — ALL to paathshala_app

```sql
USING ((tenant_id = app_current_tenant_id()) AND app_actor_has_finance_scope())
```

```sql
WITH CHECK ((tenant_id = app_current_tenant_id()) AND app_actor_has_finance_scope())
```

**Policy `payment_read`** — SELECT to paathshala_app

```sql
USING ((tenant_id = app_current_tenant_id()) AND (app_actor_has_finance_scope() OR (payer_person_id = app_current_person_id())))
```

### `payment_allocation`

Row-level security: **enabled**, **forced** (applies to the table owner too)

| Column | Type | Null |
| --- | --- | --- |
| id | uuid |  |
| tenant_id | uuid |  |
| payment_id | uuid |  |
| invoice_id | uuid |  |
| amount | numeric |  |
| allocated_at | timestamp with time zone |  |
| allocated_by | uuid | yes |

**Policy `finance_only`** — ALL to paathshala_app

```sql
USING ((tenant_id = app_current_tenant_id()) AND app_actor_has_finance_scope())
```

```sql
WITH CHECK ((tenant_id = app_current_tenant_id()) AND app_actor_has_finance_scope())
```

### `payment_attempt`

Row-level security: **enabled**, **forced** (applies to the table owner too)

| Column | Type | Null |
| --- | --- | --- |
| id | uuid |  |
| tenant_id | uuid |  |
| payment_id | uuid |  |
| provider_order_id | text | yes |
| provider_status | text | yes |
| error_code | text | yes |
| error_message | text | yes |
| raw_response_ref | text | yes |
| attempted_at | timestamp with time zone |  |

**Policy `finance_only`** — ALL to paathshala_app

```sql
USING ((tenant_id = app_current_tenant_id()) AND app_actor_has_finance_scope())
```

```sql
WITH CHECK ((tenant_id = app_current_tenant_id()) AND app_actor_has_finance_scope())
```

### `payment_webhook_event`

Row-level security: **enabled**, **forced** (applies to the table owner too)

| Column | Type | Null |
| --- | --- | --- |
| id | uuid |  |
| tenant_id | uuid |  |
| provider | text |  |
| provider_event_id | text |  |
| event_type | text |  |
| raw_body | text |  |
| signature_valid | boolean |  |
| processed_at | timestamp with time zone | yes |
| received_at | timestamp with time zone |  |

**Policy `finance_only`** — ALL to paathshala_app

```sql
USING ((tenant_id = app_current_tenant_id()) AND app_actor_has_finance_scope())
```

```sql
WITH CHECK ((tenant_id = app_current_tenant_id()) AND app_actor_has_finance_scope())
```

### `person`

Row-level security: **enabled**, **forced** (applies to the table owner too)

| Column | Type | Null |
| --- | --- | --- |
| id | uuid |  |
| tenant_id | uuid |  |
| user_account_id | uuid | yes |
| given_name | text |  |
| middle_name | text | yes |
| family_name | text | yes |
| preferred_name | text | yes |
| date_of_birth | date | yes |
| gender | text | yes |
| created_at | timestamp with time zone |  |
| updated_at | timestamp with time zone |  |
| deleted_at | timestamp with time zone | yes |

Column-level grants (narrower than the table):

- `paathshala_health` may **select** only: `family_name`, `given_name`, `id`, `user_account_id`, `tenant_id`

**Policy `guardian_scope`** — ALL to paathshala_app

```sql
USING ((tenant_id = app_current_tenant_id()) AND (app_actor_has_staff_scope() OR (id = app_current_person_id()) OR (EXISTS ( SELECT 1
   FROM (guardian_link gl
     JOIN student s ON ((s.id = gl.student_id)))
  WHERE ((s.person_id = person.id) AND (gl.guardian_person_id = app_current_person_id()) AND (gl.effective_to IS NULL))))))
```

```sql
WITH CHECK ((tenant_id = app_current_tenant_id()) AND app_actor_has_staff_scope())
```

**Policy `health_scope`** — SELECT to paathshala_health

```sql
USING (tenant_id = app_current_tenant_id())
```

### `platform_admin`

Row-level security: **enabled**, **forced** (applies to the table owner too)

| Column | Type | Null |
| --- | --- | --- |
| id | uuid |  |
| user_account_id | uuid |  |
| capability | text |  |
| granted_by | uuid | yes |
| granted_at | timestamp with time zone |  |
| revoked_at | timestamp with time zone | yes |
| revoked_by | uuid | yes |
| note | text | yes |

**Policy `platform_only`** — ALL to paathshala_platform

```sql
USING true
```

```sql
WITH CHECK true
```

### `programme`

Row-level security: **enabled**, **forced** (applies to the table owner too)

| Column | Type | Null |
| --- | --- | --- |
| id | uuid |  |
| tenant_id | uuid |  |
| academic_unit_id | uuid |  |
| code | text |  |
| name | text |  |
| duration_terms | integer | yes |
| credential_type | text | yes |
| created_at | timestamp with time zone |  |
| updated_at | timestamp with time zone |  |
| deleted_at | timestamp with time zone | yes |

**Policy `staff_delete`** — DELETE to paathshala_app

```sql
USING ((tenant_id = app_current_tenant_id()) AND app_actor_has_staff_scope())
```

**Policy `staff_insert`** — INSERT to paathshala_app

```sql
WITH CHECK ((tenant_id = app_current_tenant_id()) AND app_actor_has_staff_scope())
```

**Policy `staff_update`** — UPDATE to paathshala_app

```sql
USING ((tenant_id = app_current_tenant_id()) AND app_actor_has_staff_scope())
```

```sql
WITH CHECK ((tenant_id = app_current_tenant_id()) AND app_actor_has_staff_scope())
```

**Policy `tenant_read`** — SELECT to paathshala_app

```sql
USING (tenant_id = app_current_tenant_id())
```

### `receipt`

Row-level security: **enabled**, **forced** (applies to the table owner too)

| Column | Type | Null |
| --- | --- | --- |
| id | uuid |  |
| tenant_id | uuid |  |
| campus_id | uuid |  |
| payment_id | uuid |  |
| receipt_no | text |  |
| financial_year | text |  |
| issued_on | date |  |
| amount | numeric |  |
| file_id | uuid | yes |
| checksum | text | yes |
| cancelled_by_receipt_id | uuid | yes |
| created_at | timestamp with time zone |  |

**Policy `receipt_finance_write`** — ALL to paathshala_app

```sql
USING ((tenant_id = app_current_tenant_id()) AND app_actor_has_finance_scope())
```

```sql
WITH CHECK ((tenant_id = app_current_tenant_id()) AND app_actor_has_finance_scope())
```

**Policy `receipt_read`** — SELECT to paathshala_app

```sql
USING ((tenant_id = app_current_tenant_id()) AND (app_actor_has_finance_scope() OR (EXISTS ( SELECT 1
   FROM payment p
  WHERE ((p.id = receipt.payment_id) AND (p.payer_person_id = app_current_person_id()))))))
```

### `refund`

Row-level security: **enabled**, **forced** (applies to the table owner too)

| Column | Type | Null |
| --- | --- | --- |
| id | uuid |  |
| tenant_id | uuid |  |
| payment_id | uuid |  |
| amount | numeric |  |
| reason | text |  |
| requested_by | uuid |  |
| approved_by | uuid | yes |
| approved_at | timestamp with time zone | yes |
| rejected_by | uuid | yes |
| rejected_at | timestamp with time zone | yes |
| provider_refund_id | text | yes |
| status | text |  |
| settled_on | date | yes |
| idempotency_key | text |  |
| created_at | timestamp with time zone |  |
| updated_at | timestamp with time zone |  |

**Policy `finance_only`** — ALL to paathshala_app

```sql
USING ((tenant_id = app_current_tenant_id()) AND app_actor_has_finance_scope())
```

```sql
WITH CHECK ((tenant_id = app_current_tenant_id()) AND app_actor_has_finance_scope())
```

### `report_card`

Row-level security: **enabled**, **forced** (applies to the table owner too)

| Column | Type | Null |
| --- | --- | --- |
| id | uuid |  |
| tenant_id | uuid |  |
| enrollment_id | uuid |  |
| term_id | uuid |  |
| result_run_id | uuid |  |
| template_id | uuid | yes |
| version | integer |  |
| status | text |  |
| artefact_file_id | uuid | yes |
| artefact_sha256 | text | yes |
| snapshot | jsonb | yes |
| published_at | timestamp with time zone | yes |
| published_by | uuid | yes |
| superseded_by | uuid | yes |
| supersede_reason | text | yes |
| created_at | timestamp with time zone |  |

**Policy `report_card_read`** — SELECT to paathshala_app

```sql
USING ((tenant_id = app_current_tenant_id()) AND (app_actor_has_staff_scope() OR ((status = ANY (ARRAY['published'::text, 'superseded'::text])) AND ((EXISTS ( SELECT 1
   FROM (enrollment e
     JOIN student s ON ((s.id = e.student_id)))
  WHERE ((e.id = report_card.enrollment_id) AND (s.person_id = app_current_person_id())))) OR (EXISTS ( SELECT 1
   FROM (enrollment e
     JOIN guardian_link gl ON ((gl.student_id = e.student_id)))
  WHERE ((e.id = report_card.enrollment_id) AND (gl.guardian_person_id = app_current_person_id()) AND (gl.effective_to IS NULL) AND gl.can_view_academics)))))))
```

**Policy `report_card_staff_write`** — ALL to paathshala_app

```sql
USING ((tenant_id = app_current_tenant_id()) AND app_actor_has_staff_scope())
```

```sql
WITH CHECK ((tenant_id = app_current_tenant_id()) AND app_actor_has_staff_scope())
```

### `report_card_template`

Row-level security: **enabled**, **forced** (applies to the table owner too)

| Column | Type | Null |
| --- | --- | --- |
| id | uuid |  |
| tenant_id | uuid |  |
| academic_unit_id | uuid |  |
| name | text |  |
| board | text | yes |
| layout | jsonb |  |
| version | integer |  |
| is_published | boolean |  |
| published_at | timestamp with time zone | yes |
| created_at | timestamp with time zone |  |
| updated_at | timestamp with time zone |  |
| deleted_at | timestamp with time zone | yes |

**Policy `structure_read`** — SELECT to paathshala_app

```sql
USING (tenant_id = app_current_tenant_id())
```

**Policy `structure_staff_write`** — ALL to paathshala_app

```sql
USING ((tenant_id = app_current_tenant_id()) AND app_actor_has_staff_scope())
```

```sql
WITH CHECK ((tenant_id = app_current_tenant_id()) AND app_actor_has_staff_scope())
```

### `result_line`

Row-level security: **enabled**, **forced** (applies to the table owner too)

| Column | Type | Null |
| --- | --- | --- |
| id | uuid |  |
| tenant_id | uuid |  |
| result_run_id | uuid |  |
| enrollment_id | uuid |  |
| course_offering_id | uuid | yes |
| obtained | numeric | yes |
| maximum | numeric | yes |
| percentage | numeric | yes |
| grade_label | text | yes |
| grade_point | numeric | yes |
| is_pass | boolean | yes |
| not_graded_reason | text | yes |
| created_at | timestamp with time zone |  |

**Policy `result_line_read`** — SELECT to paathshala_app

```sql
USING ((tenant_id = app_current_tenant_id()) AND (app_actor_has_staff_scope() OR ((EXISTS ( SELECT 1
   FROM result_run r
  WHERE ((r.id = result_line.result_run_id) AND (r.status = 'published'::text)))) AND ((EXISTS ( SELECT 1
   FROM (enrollment e
     JOIN student s ON ((s.id = e.student_id)))
  WHERE ((e.id = result_line.enrollment_id) AND (s.person_id = app_current_person_id())))) OR (EXISTS ( SELECT 1
   FROM (enrollment e
     JOIN guardian_link gl ON ((gl.student_id = e.student_id)))
  WHERE ((e.id = result_line.enrollment_id) AND (gl.guardian_person_id = app_current_person_id()) AND (gl.effective_to IS NULL) AND gl.can_view_academics)))))))
```

**Policy `result_line_staff_write`** — ALL to paathshala_app

```sql
USING ((tenant_id = app_current_tenant_id()) AND app_actor_has_staff_scope())
```

```sql
WITH CHECK ((tenant_id = app_current_tenant_id()) AND app_actor_has_staff_scope())
```

### `result_run`

Row-level security: **enabled**, **forced** (applies to the table owner too)

| Column | Type | Null |
| --- | --- | --- |
| id | uuid |  |
| tenant_id | uuid |  |
| academic_year_id | uuid |  |
| term_id | uuid |  |
| section_id | uuid |  |
| inputs_digest | text |  |
| grading_scale_id | uuid | yes |
| policy | jsonb |  |
| status | text |  |
| computed_at | timestamp with time zone |  |
| computed_by | uuid | yes |
| reviewed_at | timestamp with time zone | yes |
| reviewed_by | uuid | yes |
| published_at | timestamp with time zone | yes |
| published_by | uuid | yes |
| superseded_by | uuid | yes |
| supersede_reason | text | yes |
| created_at | timestamp with time zone |  |

**Policy `result_run_staff`** — ALL to paathshala_app

```sql
USING ((tenant_id = app_current_tenant_id()) AND app_actor_has_staff_scope())
```

```sql
WITH CHECK ((tenant_id = app_current_tenant_id()) AND app_actor_has_staff_scope())
```

### `role_grant`

Row-level security: **enabled**, **forced** (applies to the table owner too)

| Column | Type | Null |
| --- | --- | --- |
| id | uuid |  |
| tenant_id | uuid |  |
| user_account_id | uuid |  |
| role | text |  |
| scope_type | text |  |
| scope_id | uuid | yes |
| granted_by | uuid | yes |
| granted_at | timestamp with time zone |  |
| expires_at | timestamp with time zone | yes |
| revoked_at | timestamp with time zone | yes |

**Policy `auth_role_reads_grants`** — SELECT to paathshala_auth

```sql
USING true
```

**Policy `health_scope`** — SELECT to paathshala_health

```sql
USING (tenant_id = app_current_tenant_id())
```

**Policy `platform_all_tenants`** — ALL to paathshala_platform

```sql
USING true
```

```sql
WITH CHECK true
```

**Policy `tenant_isolation`** — ALL to paathshala_app

```sql
USING (tenant_id = app_current_tenant_id())
```

```sql
WITH CHECK (tenant_id = app_current_tenant_id())
```

### `room`

Row-level security: **enabled**, **forced** (applies to the table owner too)

| Column | Type | Null |
| --- | --- | --- |
| id | uuid |  |
| tenant_id | uuid |  |
| campus_id | uuid |  |
| code | text |  |
| name | text |  |
| capacity | integer | yes |
| room_type | text |  |
| created_at | timestamp with time zone |  |
| updated_at | timestamp with time zone |  |
| deleted_at | timestamp with time zone | yes |

**Policy `staff_delete`** — DELETE to paathshala_app

```sql
USING ((tenant_id = app_current_tenant_id()) AND app_actor_has_staff_scope())
```

**Policy `staff_insert`** — INSERT to paathshala_app

```sql
WITH CHECK ((tenant_id = app_current_tenant_id()) AND app_actor_has_staff_scope())
```

**Policy `staff_update`** — UPDATE to paathshala_app

```sql
USING ((tenant_id = app_current_tenant_id()) AND app_actor_has_staff_scope())
```

```sql
WITH CHECK ((tenant_id = app_current_tenant_id()) AND app_actor_has_staff_scope())
```

**Policy `tenant_read`** — SELECT to paathshala_app

```sql
USING (tenant_id = app_current_tenant_id())
```

### `schedule_slot`

Row-level security: **enabled**, **forced** (applies to the table owner too)

| Column | Type | Null |
| --- | --- | --- |
| id | uuid |  |
| tenant_id | uuid |  |
| course_offering_id | uuid |  |
| section_id | uuid | yes |
| room_id | uuid | yes |
| staff_id | uuid | yes |
| day_of_week | smallint |  |
| period_no | smallint | yes |
| starts_at | time without time zone |  |
| ends_at | time without time zone |  |
| academic_year_id | uuid | yes |
| effective_from | date |  |
| effective_to | date | yes |
| minutes | int4range | yes |
| created_at | timestamp with time zone |  |
| updated_at | timestamp with time zone |  |
| deleted_at | timestamp with time zone | yes |

**Policy `staff_delete`** — DELETE to paathshala_app

```sql
USING ((tenant_id = app_current_tenant_id()) AND app_actor_has_staff_scope())
```

**Policy `staff_insert`** — INSERT to paathshala_app

```sql
WITH CHECK ((tenant_id = app_current_tenant_id()) AND app_actor_has_staff_scope())
```

**Policy `staff_update`** — UPDATE to paathshala_app

```sql
USING ((tenant_id = app_current_tenant_id()) AND app_actor_has_staff_scope())
```

```sql
WITH CHECK ((tenant_id = app_current_tenant_id()) AND app_actor_has_staff_scope())
```

**Policy `tenant_read`** — SELECT to paathshala_app

```sql
USING (tenant_id = app_current_tenant_id())
```

### `schema_migration`

Row-level security: **not enabled**

| Column | Type | Null |
| --- | --- | --- |
| name | text |  |
| checksum | text |  |
| applied_at | timestamp with time zone |  |

### `section`

Row-level security: **enabled**, **forced** (applies to the table owner too)

| Column | Type | Null |
| --- | --- | --- |
| id | uuid |  |
| tenant_id | uuid |  |
| class_group_id | uuid |  |
| name | text |  |
| capacity | integer | yes |
| class_teacher_staff_id | uuid | yes |
| room_id | uuid | yes |
| created_at | timestamp with time zone |  |
| updated_at | timestamp with time zone |  |
| deleted_at | timestamp with time zone | yes |

**Policy `staff_delete`** — DELETE to paathshala_app

```sql
USING ((tenant_id = app_current_tenant_id()) AND app_actor_has_staff_scope())
```

**Policy `staff_insert`** — INSERT to paathshala_app

```sql
WITH CHECK ((tenant_id = app_current_tenant_id()) AND app_actor_has_staff_scope())
```

**Policy `staff_update`** — UPDATE to paathshala_app

```sql
USING ((tenant_id = app_current_tenant_id()) AND app_actor_has_staff_scope())
```

```sql
WITH CHECK ((tenant_id = app_current_tenant_id()) AND app_actor_has_staff_scope())
```

**Policy `tenant_read`** — SELECT to paathshala_app

```sql
USING (tenant_id = app_current_tenant_id())
```

### `session`

Row-level security: **enabled**, **forced** (applies to the table owner too)

| Column | Type | Null |
| --- | --- | --- |
| id | uuid |  |
| user_account_id | uuid |  |
| device_id | uuid | yes |
| family_id | uuid |  |
| refresh_token_hash | text |  |
| parent_session_id | uuid | yes |
| ip | inet | yes |
| city | text | yes |
| user_agent | text | yes |
| issued_at | timestamp with time zone |  |
| expires_at | timestamp with time zone |  |
| last_seen_at | timestamp with time zone |  |
| rotated_at | timestamp with time zone | yes |
| revoked_at | timestamp with time zone | yes |
| revoked_reason | text | yes |

**Policy `auth_role_full_access`** — ALL to paathshala_auth

```sql
USING true
```

```sql
WITH CHECK true
```

### `settlement_batch`

Row-level security: **enabled**, **forced** (applies to the table owner too)

| Column | Type | Null |
| --- | --- | --- |
| id | uuid |  |
| tenant_id | uuid |  |
| provider | text |  |
| utr | text |  |
| settled_on | date |  |
| gross_amount | numeric |  |
| fee_amount | numeric |  |
| tax_amount | numeric |  |
| net_amount | numeric |  |
| statement_file_id | uuid | yes |
| imported_at | timestamp with time zone |  |

**Policy `finance_only`** — ALL to paathshala_app

```sql
USING ((tenant_id = app_current_tenant_id()) AND app_actor_has_finance_scope())
```

```sql
WITH CHECK ((tenant_id = app_current_tenant_id()) AND app_actor_has_finance_scope())
```

### `settlement_line`

Row-level security: **enabled**, **forced** (applies to the table owner too)

| Column | Type | Null |
| --- | --- | --- |
| id | uuid |  |
| tenant_id | uuid |  |
| settlement_batch_id | uuid |  |
| payment_id | uuid | yes |
| provider_payment_id | text |  |
| amount | numeric |  |
| provider_fee | numeric |  |
| match_state | text |  |
| matched_at | timestamp with time zone | yes |
| note | text | yes |
| created_at | timestamp with time zone |  |

**Policy `finance_only`** — ALL to paathshala_app

```sql
USING ((tenant_id = app_current_tenant_id()) AND app_actor_has_finance_scope())
```

```sql
WITH CHECK ((tenant_id = app_current_tenant_id()) AND app_actor_has_finance_scope())
```

### `staff`

Row-level security: **enabled**, **forced** (applies to the table owner too)

| Column | Type | Null |
| --- | --- | --- |
| id | uuid |  |
| tenant_id | uuid |  |
| person_id | uuid |  |
| campus_id | uuid |  |
| employee_code | text |  |
| designation | text | yes |
| department | text | yes |
| joined_on | date |  |
| left_on | date | yes |
| status | text |  |
| created_at | timestamp with time zone |  |
| updated_at | timestamp with time zone |  |
| deleted_at | timestamp with time zone | yes |

**Policy `tenant_isolation`** — ALL to paathshala_app

```sql
USING (tenant_id = app_current_tenant_id())
```

```sql
WITH CHECK (tenant_id = app_current_tenant_id())
```

### `student`

Row-level security: **enabled**, **forced** (applies to the table owner too)

| Column | Type | Null |
| --- | --- | --- |
| id | uuid |  |
| tenant_id | uuid |  |
| person_id | uuid |  |
| admission_no | text |  |
| lifecycle_status | text |  |
| first_admitted_on | date | yes |
| blood_group | text | yes |
| medical_note | text | yes |
| accommodations | text | yes |
| emergency_contact_name | text | yes |
| emergency_contact_phone | text | yes |
| created_at | timestamp with time zone |  |
| updated_at | timestamp with time zone |  |
| deleted_at | timestamp with time zone | yes |

Column-level grants (narrower than the table):

- `paathshala_app` may **select** only: `admission_no`, `tenant_id`, `first_admitted_on`, `created_at`, `updated_at`, `lifecycle_status`, `person_id`, `id`, `deleted_at`
- `paathshala_app` may **update** only: `lifecycle_status`, `first_admitted_on`, `deleted_at`, `admission_no`
- `paathshala_health` may **select** only: `blood_group`, `accommodations`, `emergency_contact_name`, `emergency_contact_phone`, `person_id`, `medical_note`, `tenant_id`, `deleted_at`, `id`, `admission_no`
- `paathshala_health` may **update** only: `emergency_contact_phone`, `blood_group`, `emergency_contact_name`, `medical_note`, `accommodations`

**Policy `health_scope`** — ALL to paathshala_health

```sql
USING ((tenant_id = app_current_tenant_id()) AND app_student_visible(id, person_id))
```

```sql
WITH CHECK ((tenant_id = app_current_tenant_id()) AND app_actor_has_whole_school_scope())
```

**Policy `section_or_guardian`** — ALL to paathshala_app

```sql
USING ((tenant_id = app_current_tenant_id()) AND app_student_visible(id, person_id))
```

```sql
WITH CHECK ((tenant_id = app_current_tenant_id()) AND app_actor_has_whole_school_scope())
```

### `subject`

Row-level security: **enabled**, **forced** (applies to the table owner too)

| Column | Type | Null |
| --- | --- | --- |
| id | uuid |  |
| tenant_id | uuid |  |
| academic_unit_id | uuid |  |
| code | text |  |
| name | text |  |
| subject_type | text |  |
| default_credits | numeric | yes |
| created_at | timestamp with time zone |  |
| updated_at | timestamp with time zone |  |
| deleted_at | timestamp with time zone | yes |

**Policy `staff_delete`** — DELETE to paathshala_app

```sql
USING ((tenant_id = app_current_tenant_id()) AND app_actor_has_staff_scope())
```

**Policy `staff_insert`** — INSERT to paathshala_app

```sql
WITH CHECK ((tenant_id = app_current_tenant_id()) AND app_actor_has_staff_scope())
```

**Policy `staff_update`** — UPDATE to paathshala_app

```sql
USING ((tenant_id = app_current_tenant_id()) AND app_actor_has_staff_scope())
```

```sql
WITH CHECK ((tenant_id = app_current_tenant_id()) AND app_actor_has_staff_scope())
```

**Policy `tenant_read`** — SELECT to paathshala_app

```sql
USING (tenant_id = app_current_tenant_id())
```

### `subject_election`

Row-level security: **enabled**, **forced** (applies to the table owner too)

| Column | Type | Null |
| --- | --- | --- |
| id | uuid |  |
| tenant_id | uuid |  |
| enrollment_id | uuid |  |
| course_offering_id | uuid |  |
| elected_on | date |  |
| dropped_on | date | yes |
| created_at | timestamp with time zone |  |

**Policy `staff_only`** — ALL to paathshala_app

```sql
USING ((tenant_id = app_current_tenant_id()) AND app_actor_has_staff_scope())
```

```sql
WITH CHECK ((tenant_id = app_current_tenant_id()) AND app_actor_has_staff_scope())
```

### `support_ticket`

Row-level security: **enabled**, **forced** (applies to the table owner too)

| Column | Type | Null |
| --- | --- | --- |
| id | uuid |  |
| tenant_id | uuid |  |
| reference | text |  |
| raised_by_person_id | uuid |  |
| subject | text |  |
| category | text |  |
| priority | text |  |
| status | text |  |
| assigned_to_staff_id | uuid | yes |
| first_response_due_at | timestamp with time zone |  |
| resolution_due_at | timestamp with time zone |  |
| first_responded_at | timestamp with time zone | yes |
| resolved_at | timestamp with time zone | yes |
| closed_at | timestamp with time zone | yes |
| created_at | timestamp with time zone |  |
| updated_at | timestamp with time zone |  |

**Policy `definer_bookkeeping`** — ALL to paathshala_owner

```sql
USING true
```

```sql
WITH CHECK true
```

**Policy `requester_or_staff`** — ALL to paathshala_app

```sql
USING ((tenant_id = app_current_tenant_id()) AND (app_actor_has_staff_scope() OR (raised_by_person_id = app_current_person_id())))
```

```sql
WITH CHECK ((tenant_id = app_current_tenant_id()) AND (app_actor_has_staff_scope() OR (raised_by_person_id = app_current_person_id())))
```

### `tenant_principal`

Row-level security: **enabled**, **forced** (applies to the table owner too)

| Column | Type | Null |
| --- | --- | --- |
| tenant_id | uuid |  |
| user_account_id | uuid |  |
| person_id | uuid |  |

**Policy `health_scope`** — SELECT to paathshala_health

```sql
USING (tenant_id = app_current_tenant_id())
```

**Policy `tenant_isolation`** — ALL to paathshala_app

```sql
USING (tenant_id = app_current_tenant_id())
```

```sql
WITH CHECK (tenant_id = app_current_tenant_id())
```

### `tenant_provisioning`

Row-level security: **enabled**, **forced** (applies to the table owner too)

| Column | Type | Null |
| --- | --- | --- |
| id | uuid |  |
| tenant_id | uuid | yes |
| request_key | text |  |
| legal_name | text |  |
| display_name | text |  |
| owner_email | text |  |
| status | text |  |
| failure_reason | text | yes |
| provisioned_by | uuid |  |
| created_at | timestamp with time zone |  |

**Policy `platform_only`** — ALL to paathshala_platform

```sql
USING true
```

```sql
WITH CHECK true
```

### `term`

Row-level security: **enabled**, **forced** (applies to the table owner too)

| Column | Type | Null |
| --- | --- | --- |
| id | uuid |  |
| tenant_id | uuid |  |
| academic_year_id | uuid |  |
| label | text |  |
| sequence | integer |  |
| starts_on | date |  |
| ends_on | date |  |
| created_at | timestamp with time zone |  |
| updated_at | timestamp with time zone |  |
| deleted_at | timestamp with time zone | yes |

**Policy `staff_delete`** — DELETE to paathshala_app

```sql
USING ((tenant_id = app_current_tenant_id()) AND app_actor_has_staff_scope())
```

**Policy `staff_insert`** — INSERT to paathshala_app

```sql
WITH CHECK ((tenant_id = app_current_tenant_id()) AND app_actor_has_staff_scope())
```

**Policy `staff_update`** — UPDATE to paathshala_app

```sql
USING ((tenant_id = app_current_tenant_id()) AND app_actor_has_staff_scope())
```

```sql
WITH CHECK ((tenant_id = app_current_tenant_id()) AND app_actor_has_staff_scope())
```

**Policy `tenant_read`** — SELECT to paathshala_app

```sql
USING (tenant_id = app_current_tenant_id())
```

### `ticket_event`

Row-level security: **enabled**, **forced** (applies to the table owner too)

| Column | Type | Null |
| --- | --- | --- |
| id | uuid |  |
| tenant_id | uuid |  |
| ticket_id | uuid |  |
| actor_person_id | uuid | yes |
| kind | text |  |
| detail | jsonb |  |
| occurred_at | timestamp with time zone |  |

**Policy `thread_visibility`** — ALL to paathshala_app

```sql
USING ((tenant_id = app_current_tenant_id()) AND (EXISTS ( SELECT 1
   FROM support_ticket t
  WHERE ((t.id = ticket_event.ticket_id) AND (app_actor_has_staff_scope() OR (t.raised_by_person_id = app_current_person_id()))))))
```

```sql
WITH CHECK ((tenant_id = app_current_tenant_id()) AND (EXISTS ( SELECT 1
   FROM support_ticket t
  WHERE ((t.id = ticket_event.ticket_id) AND (app_actor_has_staff_scope() OR (t.raised_by_person_id = app_current_person_id()))))))
```

### `ticket_message`

Row-level security: **enabled**, **forced** (applies to the table owner too)

| Column | Type | Null |
| --- | --- | --- |
| id | uuid |  |
| tenant_id | uuid |  |
| ticket_id | uuid |  |
| author_person_id | uuid |  |
| body | text |  |
| is_internal | boolean |  |
| created_at | timestamp with time zone |  |

**Policy `thread_visibility`** — ALL to paathshala_app

```sql
USING ((tenant_id = app_current_tenant_id()) AND ((NOT is_internal) OR app_actor_has_staff_scope()) AND (EXISTS ( SELECT 1
   FROM support_ticket t
  WHERE ((t.id = ticket_message.ticket_id) AND (app_actor_has_staff_scope() OR (t.raised_by_person_id = app_current_person_id()))))))
```

```sql
WITH CHECK ((tenant_id = app_current_tenant_id()) AND ((NOT is_internal) OR app_actor_has_staff_scope()) AND (app_actor_has_staff_scope() OR (author_person_id = app_current_person_id())) AND (EXISTS ( SELECT 1
   FROM support_ticket t
  WHERE ((t.id = ticket_message.ticket_id) AND (app_actor_has_staff_scope() OR (t.raised_by_person_id = app_current_person_id()))))))
```

### `user_account`

Row-level security: **enabled**, **forced** (applies to the table owner too)

| Column | Type | Null |
| --- | --- | --- |
| id | uuid |  |
| login_email | USER-DEFINED | yes |
| login_phone | text | yes |
| password_hash | text | yes |
| mfa_secret_ref | text | yes |
| status | text |  |
| grants_version | integer |  |
| failed_attempts | integer |  |
| locked_until | timestamp with time zone | yes |
| last_login_at | timestamp with time zone | yes |
| created_at | timestamp with time zone |  |
| updated_at | timestamp with time zone |  |
| deleted_at | timestamp with time zone | yes |

Column-level grants (narrower than the table):

- `paathshala_app` may **select** only: `login_phone`, `status`, `last_login_at`, `id`, `login_email`, `grants_version`
- `paathshala_platform` may **insert** only: `password_hash`, `login_email`, `status`
- `paathshala_platform` may **select** only: `id`, `login_email`, `status`, `created_at`

**Policy `auth_role_full_access`** — ALL to paathshala_auth

```sql
USING true
```

```sql
WITH CHECK true
```

**Policy `platform_creates_owners`** — INSERT to paathshala_platform

```sql
WITH CHECK true
```

**Policy `platform_reads_accounts`** — SELECT to paathshala_platform

```sql
USING true
```

**Policy `tenant_visible_users`** — SELECT to paathshala_app

```sql
USING (EXISTS ( SELECT 1
   FROM role_grant g
  WHERE ((g.user_account_id = user_account.id) AND (g.tenant_id = app_current_tenant_id()) AND (g.revoked_at IS NULL))))
```

### `waiver`

Row-level security: **enabled**, **forced** (applies to the table owner too)

| Column | Type | Null |
| --- | --- | --- |
| id | uuid |  |
| tenant_id | uuid |  |
| invoice_id | uuid |  |
| amount | numeric |  |
| reason | text |  |
| approved_by | uuid |  |
| approved_at | timestamp with time zone |  |
| created_at | timestamp with time zone |  |

**Policy `finance_only`** — ALL to paathshala_app

```sql
USING ((tenant_id = app_current_tenant_id()) AND app_actor_has_finance_scope())
```

```sql
WITH CHECK ((tenant_id = app_current_tenant_id()) AND app_actor_has_finance_scope())
```

### `webhook_attempt`

Row-level security: **enabled**, **forced** (applies to the table owner too)

| Column | Type | Null |
| --- | --- | --- |
| id | uuid |  |
| tenant_id | uuid |  |
| webhook_delivery_id | uuid |  |
| attempt_no | integer |  |
| attempted_at | timestamp with time zone |  |
| duration_ms | integer | yes |
| response_status | integer | yes |
| response_excerpt | text | yes |
| error | text | yes |

**Policy `staff_read`** — ALL to paathshala_app

```sql
USING ((tenant_id = app_current_tenant_id()) AND app_actor_has_staff_scope())
```

```sql
WITH CHECK ((tenant_id = app_current_tenant_id()) AND app_actor_has_staff_scope())
```

### `webhook_delivery`

Row-level security: **enabled**, **forced** (applies to the table owner too)

| Column | Type | Null |
| --- | --- | --- |
| id | uuid |  |
| tenant_id | uuid |  |
| webhook_endpoint_id | uuid |  |
| outbox_event_id | uuid |  |
| event_type | text |  |
| payload | jsonb |  |
| status | text |  |
| attempt_count | integer |  |
| next_attempt_at | timestamp with time zone |  |
| last_error | text | yes |
| succeeded_at | timestamp with time zone | yes |
| created_at | timestamp with time zone |  |
| attempt_baseline | integer |  |

**Policy `staff_read`** — ALL to paathshala_app

```sql
USING ((tenant_id = app_current_tenant_id()) AND app_actor_has_staff_scope())
```

```sql
WITH CHECK ((tenant_id = app_current_tenant_id()) AND app_actor_has_staff_scope())
```

### `webhook_endpoint`

Row-level security: **enabled**, **forced** (applies to the table owner too)

| Column | Type | Null |
| --- | --- | --- |
| id | uuid |  |
| tenant_id | uuid |  |
| url | text |  |
| description | text | yes |
| event_types | ARRAY |  |
| status | text |  |
| signing_secret | text |  |
| previous_secret | text | yes |
| secret_rotated_at | timestamp with time zone | yes |
| disabled_reason | text | yes |
| created_by | uuid | yes |
| created_at | timestamp with time zone |  |
| updated_at | timestamp with time zone |  |

Column-level grants (narrower than the table):

- `paathshala_app` may **select** only: `url`, `event_types`, `status`, `tenant_id`, `created_by`, `created_at`, `description`, `disabled_reason`, `secret_rotated_at`, `updated_at`, `id`
- `paathshala_app` may **update** only: `description`, `disabled_reason`, `status`, `event_types`, `url`

**Policy `definer_bookkeeping`** — ALL to paathshala_owner

```sql
USING true
```

```sql
WITH CHECK true
```

**Policy `integration_scope`** — ALL to paathshala_app

```sql
USING ((tenant_id = app_current_tenant_id()) AND app_actor_has_integration_scope())
```

```sql
WITH CHECK ((tenant_id = app_current_tenant_id()) AND app_actor_has_integration_scope())
```

### `whatsapp_session`

Row-level security: **enabled**, **forced** (applies to the table owner too)

| Column | Type | Null |
| --- | --- | --- |
| id | uuid |  |
| tenant_id | uuid |  |
| person_id | uuid |  |
| last_inbound_at | timestamp with time zone |  |
| created_at | timestamp with time zone |  |

**Policy `staff_only`** — ALL to paathshala_app

```sql
USING ((tenant_id = app_current_tenant_id()) AND app_actor_has_staff_scope())
```

```sql
WITH CHECK ((tenant_id = app_current_tenant_id()) AND app_actor_has_staff_scope())
```

