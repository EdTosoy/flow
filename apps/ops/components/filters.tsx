import { url } from './common';
export function Filters({
  section,
  book,
  evaluation,
  values,
  states = [],
  categories = [],
}: {
  section: string;
  book: string;
  evaluation?: string | undefined;
  values: Record<string, string | undefined>;
  states?: string[];
  categories?: readonly string[];
}) {
  return (
    <form className="filters" method="get" action={url(section, null)}>
      <input type="hidden" name="book" value={book} />
      {evaluation && (
        <input type="hidden" name="evaluation" value={evaluation} />
      )}
      {states.length > 0 && (
        <label>
          Status
          <select name="status" defaultValue={values['status'] ?? ''}>
            <option value="">All statuses</option>
            {states.map((v) => (
              <option key={v}>{v}</option>
            ))}
          </select>
        </label>
      )}
      {categories.length > 0 && (
        <label>
          Category
          <select name="category" defaultValue={values['category'] ?? ''}>
            <option value="">All categories</option>
            {categories.map((v) => (
              <option key={v}>{v}</option>
            ))}
          </select>
        </label>
      )}
      {section !== 'workers' && (
        <label>
          Currency
          <select name="currency" defaultValue={values['currency'] ?? ''}>
            <option value="">All currencies</option>
            <option>PHP</option>
            <option>USD</option>
          </select>
        </label>
      )}
      {section !== 'controls' && (
        <label>
          Exact identifier
          <input
            name="id"
            defaultValue={values['id'] ?? ''}
            placeholder="UUID"
            maxLength={36}
          />
        </label>
      )}
      <button type="submit">Apply filters</button>
      <a href={url(section, book, evaluation)}>Clear</a>
    </form>
  );
}
