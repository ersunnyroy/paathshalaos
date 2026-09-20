/**
 * The information somebody needs in ten seconds (M34.3).
 *
 * `peopleRepository.findStudentSensitive` reads a learner's blood group,
 * medical note, accommodations and emergency contact. It does it properly: on a
 * separate database role whose column grants are narrower than the application
 * role's, under the same row-level security, and it writes an audit row whether
 * or not it returned anything — because a refused attempt on a medical note is
 * exactly as interesting as a successful one.
 *
 * **Nothing could call it.** A method-level sweep found that the whole of
 * `peopleRepository` has no caller anywhere in `src/`: the directory controller
 * writes its own SQL, and that SQL returns a name, an admission number and a
 * date of birth. So a school could not see a child's allergies from anywhere in
 * this product, and a teacher standing over a child who had collapsed had
 * nothing to read.
 *
 * That is why this is one small controller rather than a tidy-up of the
 * repository: the gap is a person's, not an architecture's.
 *
 * ## Deliberately not on the learner list
 *
 * A separate route, not extra columns on `/v1/students/:id`. Sensitive fields
 * that ride along with an ordinary read are fields that end up in a CSV export,
 * a log line and a support screenshot — and every one of those reads is audited
 * as if somebody had asked for a medical note, which makes the audit trail
 * useless for spotting somebody who actually did.
 */
import { Controller, Get, Param, NotFoundException } from '@nestjs/common';
import { z } from 'zod';
import { peopleRepository } from './people.repository.ts';
import { currentScope } from '../../common/scope.ts';
import { ApiError } from '../../common/errors.ts';

const uuid = z.string().uuid();

@Controller('v1/students')
export class EmergencyController {
  /**
   * Blood group, medical note, accommodations, and who to call.
   *
   * Refused rows and missing learners answer the same way, which is the rule
   * the rest of this product follows: a 403 confirms the id exists.
   */
  @Get(':id/emergency')
  async emergency(@Param('id') id: string) {
    const studentId = uuid.safeParse(id);
    if (!studentId.success) throw ApiError.fromZod(studentId.error);

    const found = await peopleRepository.findStudentSensitive(
      currentScope(), studentId.data);
    if (!found) {
      throw new NotFoundException(
        ApiError.notFound('student_not_found', 'Learner not found.'));
    }
    return { data: found };
  }

  /**
   * Who may collect this child, and what each of them is allowed to do.
   *
   * `guardiansOf` had no caller either. `can_authorise_pickup` has been a
   * column since M3 and a permission the product enforces, and the office had
   * no screen that could answer "is this person allowed to take her home".
   */
  @Get(':id/guardians')
  async guardians(@Param('id') id: string) {
    const studentId = uuid.safeParse(id);
    if (!studentId.success) throw ApiError.fromZod(studentId.error);
    return { data: await peopleRepository.guardiansOf(currentScope(), studentId.data) };
  }
}
