-- Customer inquiries own TP (customer-accepted price), separate from offer and
-- inventory pricing. Nullable columns preserve historical inquiries that had no TP.
alter table customer_inquiries add column if not exists tp_amount numeric(14,4);
alter table customer_inquiries add column if not exists tp_currency text;
