import { describe, expect, it } from 'vitest';
import {
  headerLines, letterheadProblems, missingForPaper, signatory, type Letterhead,
} from '../src/lib/letterhead';

const blank: Letterhead = {
  address_line1: null, address_line2: null, city: null, state: null, pincode: null,
  phone: null, email: null, website: null, affiliation_body: null, affiliation_no: null,
  school_code: null, udise_code: null, signatory_name: null, signatory_title: null,
};
const full: Letterhead = {
  address_line1: '12 Station Road', address_line2: 'Near Clock Tower', city: 'Munger',
  state: 'Bihar', pincode: '811201', phone: '06344 222333', email: 'office@school.example',
  website: 'school.example', affiliation_body: 'CBSE', affiliation_no: '330123',
  school_code: '65432', udise_code: '10240100101',
  signatory_name: 'Anjali Menon', signatory_title: 'Principal',
};

describe('the lines under the school’s name', () => {
  it('are address, contact and affiliation, in that order', () => {
    expect(headerLines(full)).toEqual([
      '12 Station Road, Near Clock Tower, Munger, Bihar – 811201',
      'Tel: 06344 222333 · office@school.example · school.example',
      'Affiliated to CBSE, No. 330123 · School code 65432 · UDISE+ 10240100101',
    ]);
  });
  it('are nothing at all for a school that has filled in nothing', () => {
    expect(headerLines(blank)).toEqual([]);
    expect(headerLines(null)).toEqual([]);
    expect(headerLines({ ...blank, address_line1: '   ', phone: ' ' })).toEqual([]);
  });
  it('leave out what is missing without leaving its punctuation behind', () => {
    expect(headerLines({ ...blank, city: 'Munger' })).toEqual(['Munger']);
    expect(headerLines({ ...blank, city: 'Munger', pincode: '811201' })).toEqual(['Munger – 811201']);
    expect(headerLines({ ...blank, pincode: '811201' })).toEqual(['811201']);
    expect(headerLines({ ...blank, address_line1: ' 12 Station Road ', state: 'Bihar' }))
      .toEqual(['12 Station Road, Bihar']);
    expect(headerLines({ ...blank, email: 'a@b.co' })).toEqual(['a@b.co']);
    expect(headerLines({ ...blank, affiliation_no: '330123' })).toEqual(['Affiliated to the board, No. 330123']);
    expect(headerLines({ ...blank, affiliation_body: 'CBSE' })).toEqual(['Affiliated to CBSE']);
    expect(headerLines({ ...blank, udise_code: '10240100101' })).toEqual(['UDISE+ 10240100101']);
  });
});

describe('who signs', () => {
  it('is the name and title, the title alone, or the fallback', () => {
    expect(signatory(full, 'Head of school')).toEqual(['Anjali Menon', 'Principal']);
    expect(signatory({ ...blank, signatory_title: 'Director' }, 'Head of school')).toEqual(['Director']);
    expect(signatory({ ...blank, signatory_name: 'Anjali Menon' }, 'Head of school'))
      .toEqual(['Anjali Menon', 'Head of school']);
    expect(signatory(null, 'Head of school')).toEqual(['Head of school']);
  });
});

describe('what is wrong with the form', () => {
  it('accepts blanks and well-formed values', () => {
    expect(letterheadProblems({})).toEqual({});
    expect(letterheadProblems({ pincode: ' 811201 ', udise_code: '10240100101', email: 'a@b.co' })).toEqual({});
    expect(letterheadProblems({ pincode: '', udise_code: ' ', email: '' })).toEqual({});
  });
  it('names the field that is wrong', () => {
    expect(Object.keys(letterheadProblems({ pincode: '81120' }))).toEqual(['pincode']);
    expect(Object.keys(letterheadProblems({ pincode: '011201' }))).toEqual(['pincode']);
    expect(Object.keys(letterheadProblems({ pincode: '8112011' }))).toEqual(['pincode']);
    expect(Object.keys(letterheadProblems({ udise_code: '1024010010' }))).toEqual(['udise_code']);
    expect(Object.keys(letterheadProblems({ udise_code: '1024010010A' }))).toEqual(['udise_code']);
    expect(Object.keys(letterheadProblems({ email: 'office@school' }))).toEqual(['email']);
    expect(Object.keys(letterheadProblems({ email: 'office school@x.y' }))).toEqual(['email']);
  });
});

describe('what a bank or a passport office will look for', () => {
  it('lists what is still blank', () => {
    expect(missingForPaper(blank)).toEqual(['address', 'telephone number', 'affiliation number']);
    expect(missingForPaper(null)).toEqual(['address', 'telephone number', 'affiliation number']);
    expect(missingForPaper(full)).toEqual([]);
    expect(missingForPaper({ ...full, city: null })).toEqual(['address']);
    expect(missingForPaper({ ...full, address_line1: ' ' })).toEqual(['address']);
    expect(missingForPaper({ ...full, phone: null, affiliation_no: null }))
      .toEqual(['telephone number', 'affiliation number']);
  });
});
