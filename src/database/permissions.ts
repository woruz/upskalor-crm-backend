export const ACTION_DEFINITIONS = [
    { name: 'create', description: 'Create a new record' },
    { name: 'read', description: 'View a record' },
    { name: 'update', description: 'Modify an existing record' },
    { name: 'delete', description: 'Remove a record' }
] as const

export const RESOURCE_DEFINITIONS = [
    { name: 'users', description: 'User management' },
    { name: 'contacts', description: 'Customer and contact records' },
    { name: 'organizations', description: 'Organization records' },
    { name: 'leads', description: 'Lead records' },
    { name: 'opportunities', description: 'Sales opportunity records' },
    { name: 'tasks', description: 'Task records' },
    { name: 'notes', description: 'Notes and comments' },
    { name: 'files', description: 'File entities' },
    { name: 'quotations', description: 'Quotation records' }
] as const

export type ActionName = (typeof ACTION_DEFINITIONS)[number]['name']
export type ResourceName = (typeof RESOURCE_DEFINITIONS)[number]['name']

