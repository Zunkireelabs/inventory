import { t } from '@lingui/core/macro';
import { Stack } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';

import { api } from '../../App';
import { PageDetail } from '../../components/nav/PageDetail';
import RecordSaleButton from '../../components/stationery/RecordSaleButton';
import { InvoiceTable, type InvoiceRow } from '../../tables/stationery/InvoiceTable';

export default function InvoiceListPage() {
  const query = useQuery({
    queryKey: ['stationery-invoice-list'],
    queryFn: async () => {
      const response = await api.get<InvoiceRow[]>(
        '/plugin/stationerysales/invoices/'
      );
      return response.data;
    }
  });

  return (
    <Stack>
      <PageDetail
        title={t`Receivables`}
        actions={[
          <RecordSaleButton
            key='record-sale'
            onSuccess={() => query.refetch()}
          />
        ]}
      />
      <InvoiceTable
        records={query.data ?? []}
        loading={query.isFetching}
        showCustomer
      />
    </Stack>
  );
}
