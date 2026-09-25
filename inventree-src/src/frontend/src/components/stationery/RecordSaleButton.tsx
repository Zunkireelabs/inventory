import { t } from '@lingui/core/macro';
import {
  Alert,
  Button,
  Divider,
  Group,
  Modal,
  NumberInput,
  SimpleGrid,
  Stack,
  Text,
  Textarea,
  ThemeIcon
} from '@mantine/core';
import { DateInput } from '@mantine/dates';
import { useMediaQuery } from '@mantine/hooks';
import {
  IconAlertCircle,
  IconCash,
  IconCircleCheck,
  IconGift,
  IconReceipt2,
  IconWorld
} from '@tabler/icons-react';
import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { api } from '../../App';
import { CustomerPicker } from './CustomerPicker';
import { ProductPicker, StockAvailabilityHint } from './ProductPicker';
import { TransactionStatusBadge } from './TransactionStatusBadge';
import { TransactionTypeCard } from './TransactionTypeCard';

type SaleType = 'b2b_credit' | 'b2c_cash' | 'b2c_online' | 'gift';

const TYPE_OPTIONS: {
  value: SaleType;
  label: string;
  icon: React.ReactNode;
  color: string;
}[] = [
  {
    value: 'b2b_credit',
    label: t`B2B Credit`,
    icon: <IconReceipt2 size={28} />,
    color: 'blue'
  },
  {
    value: 'b2c_cash',
    label: t`Cash Sale`,
    icon: <IconCash size={28} />,
    color: 'green'
  },
  {
    value: 'b2c_online',
    label: t`Online Sale`,
    icon: <IconWorld size={28} />,
    color: 'teal'
  },
  {
    value: 'gift',
    label: t`Gift`,
    icon: <IconGift size={28} />,
    color: 'grape'
  }
];

type SuccessState =
  | { kind: 'b2b'; reference: string; total: string; outstanding: string; invoiceId: number }
  | { kind: 'movement'; saleType: SaleType; partName: string; quantity: string; total: string };

const INITIAL_FORM = {
  stockItemId: null as number | null,
  stockQty: null as number | null,
  partName: null as string | null,
  quantity: '' as number | '',
  unitValue: '' as number | '',
  customerId: null as number | null,
  dueDate: null as Date | null,
  notes: ''
};

/**
 * The primary "New Sale" workflow — one button, one modal, a large 4-way
 * type selector (not a dropdown), a contextual form, and a success state.
 * Built with plain Mantine inputs + a direct mutation rather than the
 * generic ApiForm wrapper: ApiForm is schema/OPTIONS-driven and meant for
 * CRUD-style forms, whereas this screen needs bespoke layout (live running
 * total, inline stock availability, type-conditional fields, a custom
 * success panel) that's simpler to build directly than to bend a generic
 * form renderer around.
 */
export default function RecordSaleButton({
  onSuccess
}: Readonly<{ onSuccess?: () => void }>) {
  const navigate = useNavigate();
  const isMobile = useMediaQuery('(max-width: 48em)');
  const [opened, setOpened] = useState(false);
  const [saleType, setSaleType] = useState<SaleType>('b2c_cash');
  const [form, setForm] = useState(INITIAL_FORM);
  const [success, setSuccess] = useState<SuccessState | null>(null);
  const [errorDetail, setErrorDetail] = useState<string | null>(null);

  const isB2B = saleType === 'b2b_credit';
  const isGift = saleType === 'gift';

  const quantityNum = typeof form.quantity === 'number' ? form.quantity : 0;
  const unitValueNum = typeof form.unitValue === 'number' ? form.unitValue : 0;
  const runningTotal = quantityNum * unitValueNum;

  const canSubmit =
    !!form.stockItemId &&
    quantityNum > 0 &&
    unitValueNum > 0 &&
    (!isB2B || !!form.customerId);

  const mutation = useMutation({
    mutationFn: async () => {
      setErrorDetail(null);
      if (isB2B) {
        const response = await api.post(
          '/plugin/stationerysales/record-b2b-sale/',
          {
            stock_item_id: form.stockItemId,
            quantity: form.quantity,
            unit_value: form.unitValue || 0,
            customer_id: form.customerId,
            due_date: form.dueDate
              ? form.dueDate.toISOString().slice(0, 10)
              : undefined,
            notes: form.notes
          }
        );
        return { kind: 'b2b' as const, data: response.data };
      }

      const response = await api.post(
        '/plugin/stationerysales/record-sale/',
        {
          stock_item_id: form.stockItemId,
          sale_type: saleType,
          quantity: form.quantity,
          unit_value: form.unitValue || 0,
          notes: form.notes
        }
      );
      return { kind: 'movement' as const, data: response.data };
    },
    onSuccess: (result) => {
      if (result.kind === 'b2b') {
        setSuccess({
          kind: 'b2b',
          reference: result.data.reference,
          total: result.data.total,
          outstanding: result.data.outstanding,
          invoiceId: result.data.invoice_id
        });
      } else {
        setSuccess({
          kind: 'movement',
          saleType,
          partName: form.partName ?? '',
          quantity: String(form.quantity),
          total: String(runningTotal)
        });
      }
      onSuccess?.();
    },
    onError: (error: any) => {
      setErrorDetail(
        error?.response?.data?.detail ?? t`Something went wrong recording this sale`
      );
    }
  });

  const resetForNewSale = () => {
    setForm(INITIAL_FORM);
    setSuccess(null);
    setErrorDetail(null);
  };

  const closeModal = () => {
    setOpened(false);
    resetForNewSale();
  };

  return (
    <>
      <Button
        size='md'
        onClick={() => setOpened(true)}
        leftSection={<IconReceipt2 size={18} />}
      >
        {t`New Sale`}
      </Button>

      <Modal
        opened={opened}
        onClose={closeModal}
        title={t`New Sale`}
        size='lg'
        centered
        fullScreen={isMobile}
      >
        {success ? (
          <Stack align='center' py='md'>
            <ThemeIcon color='green' size={56} radius='xl' variant='light'>
              <IconCircleCheck size={32} />
            </ThemeIcon>
            {success.kind === 'b2b' ? (
              <Stack align='center' gap={4}>
                <Text fw={700} size='lg'>
                  {t`Invoice ${success.reference} created`}
                </Text>
                <Text c='dimmed'>
                  {t`Total`}: {success.total} · {t`Outstanding`}:{' '}
                  {success.outstanding}
                </Text>
              </Stack>
            ) : (
              <Stack align='center' gap={4}>
                <Group gap='xs'>
                  <TransactionStatusBadge saleType={success.saleType} />
                  <Text fw={700} size='lg'>
                    {t`Sale recorded`}
                  </Text>
                </Group>
                <Text c='dimmed'>
                  {success.partName} × {success.quantity} — {t`Total`}:{' '}
                  {success.total}
                </Text>
              </Stack>
            )}

            <Group mt='md'>
              <Button variant='light' onClick={resetForNewSale}>
                {t`New Sale`}
              </Button>
              {success.kind === 'b2b' && (
                <Button
                  onClick={() => {
                    closeModal();
                    navigate(`/receivables/invoice/${success.invoiceId}`);
                  }}
                >
                  {t`View Invoice`}
                </Button>
              )}
            </Group>
          </Stack>
        ) : (
          <Stack>
            <SimpleGrid cols={{ base: 2, sm: 4 }} spacing='xs'>
              {TYPE_OPTIONS.map((opt) => (
                <TransactionTypeCard
                  key={opt.value}
                  label={opt.label}
                  icon={opt.icon}
                  color={opt.color}
                  active={saleType === opt.value}
                  onClick={() => setSaleType(opt.value)}
                />
              ))}
            </SimpleGrid>

            <Divider />

            {errorDetail && (
              <Alert color='red' icon={<IconAlertCircle size={16} />}>
                {errorDetail}
              </Alert>
            )}

            {isB2B && (
              <CustomerPicker
                value={form.customerId}
                onChange={(customerId) => setForm((f) => ({ ...f, customerId }))}
              />
            )}

            <ProductPicker
              value={form.stockItemId}
              onChange={(stockItemId, stockQty, partName) =>
                setForm((f) => ({ ...f, stockItemId, stockQty, partName }))
              }
            />
            <StockAvailabilityHint quantity={form.stockQty} />

            <SimpleGrid cols={{ base: 1, xs: 2 }}>
              <NumberInput
                label={t`Quantity`}
                value={form.quantity}
                onChange={(v) => setForm((f) => ({ ...f, quantity: v as number }))}
                min={0}
                required
              />
              <NumberInput
                label={isGift ? t`Gift Value` : t`Unit Value`}
                value={form.unitValue}
                onChange={(v) => setForm((f) => ({ ...f, unitValue: v as number }))}
                min={0}
                decimalScale={2}
                required
                description={isGift ? t`Required for gifts` : undefined}
              />
            </SimpleGrid>

            {isB2B && (
              <DateInput
                label={t`Due Date`}
                placeholder={t`Defaults to 30 days from today`}
                value={form.dueDate}
                onChange={(v) => setForm((f) => ({ ...f, dueDate: v as unknown as Date | null }))}
                clearable
              />
            )}

            <Textarea
              label={t`Notes`}
              value={form.notes}
              onChange={(e) =>
                setForm((f) => ({ ...f, notes: e.currentTarget.value }))
              }
              autosize
              minRows={1}
            />

            <Divider />

            <Group justify='space-between' align='center'>
              <Text size='sm' c='dimmed'>
                {t`Total`}
              </Text>
              <Text size='xl' fw={800}>
                {runningTotal.toFixed(2)}
              </Text>
            </Group>

            <Button
              size='md'
              fullWidth
              disabled={!canSubmit}
              loading={mutation.isPending}
              onClick={() => mutation.mutate()}
            >
              {t`Complete Sale`}
            </Button>
          </Stack>
        )}
      </Modal>
    </>
  );
}
