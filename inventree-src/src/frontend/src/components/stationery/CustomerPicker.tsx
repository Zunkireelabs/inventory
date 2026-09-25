import { t } from '@lingui/core/macro';
import { Select } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';

import { api } from '../../App';

/** Customer typeahead for the New Sale (B2B) form — searches only
 * is_customer=true companies via the existing /api/company/ endpoint. */
export function CustomerPicker({
  value,
  onChange,
  required = true
}: Readonly<{
  value: number | null;
  onChange: (customerId: number | null) => void;
  required?: boolean;
}>) {
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');

  useEffect(() => {
    const handle = setTimeout(() => setDebounced(search), 300);
    return () => clearTimeout(handle);
  }, [search]);

  const query = useQuery({
    queryKey: ['stationery-customer-picker', debounced],
    queryFn: async () => {
      const response = await api.get('/api/company/', {
        params: { search: debounced || undefined, is_customer: true, limit: 20 }
      });
      const items = response.data.results ?? response.data;
      return items.map((item: any) => ({
        value: String(item.pk),
        label: item.name
      }));
    }
  });

  const options = query.data ?? [];

  return (
    <Select
      label={t`Customer`}
      placeholder={t`Search for a customer...`}
      searchable
      searchValue={search}
      onSearchChange={setSearch}
      data={options}
      value={value ? String(value) : null}
      onChange={(val) => onChange(val ? Number(val) : null)}
      nothingFoundMessage={
        query.isFetching ? t`Searching...` : t`No customers found`
      }
      required={required}
      clearable={!required}
    />
  );
}
