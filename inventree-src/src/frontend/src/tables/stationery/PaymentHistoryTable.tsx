import { t } from '@lingui/core/macro';
import { Badge, Table } from '@mantine/core';
import { DataTable, type DataTableColumn } from 'mantine-datatable';

export type PaymentRow = {
  id: number;
  amount: string;
  payment_date: string;
  method: string;
  reference: string;
  recorded_by: number | null;
  created_at: string;
};

const METHOD_LABEL: Record<string, string> = {
  cash: t`Cash`,
  online: t`Online`,
  cheque: t`Cheque`
};

export function PaymentHistoryTable({
  records,
  loading
}: Readonly<{ records: PaymentRow[]; loading: boolean }>) {
  const columns: DataTableColumn<PaymentRow>[] = [
    { accessor: 'payment_date', title: t`Date` },
    {
      accessor: 'amount',
      title: t`Amount`,
      textAlign: 'right'
    },
    {
      accessor: 'method',
      title: t`Method`,
      render: (row) => (
        <Badge variant='light' size='sm'>
          {METHOD_LABEL[row.method] ?? row.method}
        </Badge>
      )
    },
    { accessor: 'reference', title: t`Reference` }
  ];

  return (
    <Table.ScrollContainer minWidth={500}>
      <DataTable
        records={records}
        columns={columns}
        fetching={loading}
        idAccessor='id'
        minHeight={records.length === 0 ? 120 : undefined}
        noRecordsText={t`No payments recorded yet`}
      />
    </Table.ScrollContainer>
  );
}
