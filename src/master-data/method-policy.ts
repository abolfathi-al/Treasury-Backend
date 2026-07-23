import { TreasuryProblem } from '../common/problem';
import {
  MethodBehaviorCategory as Category,
  MethodCreateDto,
  MethodReference as Reference,
} from './master-data.dto';

const anchors = new Set([
  Reference.CASHBOX,
  Reference.BANK_ACCOUNT,
  Reference.CHEQUE,
  Reference.POS,
  Reference.GATEWAY,
]);

const requiredAnchor: Partial<Record<Category, Reference>> = {
  [Category.CASH]: Reference.CASHBOX,
  [Category.CHEQUE]: Reference.CHEQUE,
  [Category.BANK_TRANSFER]: Reference.BANK_ACCOUNT,
  [Category.DIRECT_DEPOSIT]: Reference.BANK_ACCOUNT,
  [Category.CARD_TRANSFER]: Reference.BANK_ACCOUNT,
  [Category.FOREIGN_REMITTANCE]: Reference.BANK_ACCOUNT,
  [Category.POS]: Reference.POS,
  [Category.GATEWAY]: Reference.GATEWAY,
};

const trackingRequired = new Set<Category>([
  Category.BANK_TRANSFER,
  Category.DIRECT_DEPOSIT,
  Category.CARD_TRANSFER,
  Category.WALLET,
  Category.FOREIGN_REMITTANCE,
]);

export function validateMethodSemantics(dto: MethodCreateDto): void {
  const references = new Set(dto.requiredReferences);
  const expectedAnchor = requiredAnchor[dto.behaviorCategory];
  const actualAnchors = [...references].filter((reference) => anchors.has(reference));
  if ((expectedAnchor && (actualAnchors.length !== 1 || actualAnchors[0] !== expectedAnchor))
    || (!expectedAnchor && actualAnchors.length > 0)) {
    throw invalid('Required resource anchor differs from the selected behavior category.');
  }
  if (trackingRequired.has(dto.behaviorCategory) && !references.has(Reference.TRACKING_NUMBER)) {
    throw invalid('TRACKING_NUMBER is mandatory for the selected behavior category.');
  }

  const allowed = new Set(dto.allowedCurrencies);
  const limitCurrencies = new Set<string>();
  for (const limit of dto.amountLimits ?? []) {
    if (!allowed.has(limit.currency)) throw invalid('Every amount-limit currency must be allowed.');
    if (limitCurrencies.has(limit.currency)) throw invalid('Amount limits must be unique by currency.');
    limitCurrencies.add(limit.currency);
    if (!isPositiveDecimal(limit.amount)) throw invalid('Amount limits must be positive exact decimals.');
  }

  if (dto.behaviorCategory === Category.OTHER_CONTROLLED) {
    const mappings = [
      dto.debitMappingRef,
      dto.creditMappingRef,
      dto.feeMappingRef,
      dto.discrepancyMappingRef,
      dto.templateMappingRef,
    ];
    if (mappings.some((mapping) => !mapping)) {
      throw invalid('OTHER_CONTROLLED requires all five mapping references.');
    }
    if (dto.createsFundsInTransit) {
      throw invalid('OTHER_CONTROLLED cannot add balance behavior.');
    }
  }
}

function isPositiveDecimal(value: string): boolean {
  if (!/^(?:0|[1-9][0-9]{0,29})(?:\.[0-9]{1,8})?$/u.test(value)) return false;
  return value.replace(/[0.]/gu, '').split('').some((digit) => digit !== '0');
}

function invalid(detail: string): TreasuryProblem {
  return new TreasuryProblem('TRS-MST-004', 422, detail);
}
