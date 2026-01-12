import { OrderStatus } from "generated/prisma/enums";


export interface OrderWithProducts {
    OrderItem: {
        name: any;
        productoId: number;
        quantity: number;
        price: number;
    }[];
    id: string;
    totalAmount: number;
    totalItems: number;
    status: OrderStatus;
    paid: boolean;
    paidAt: Date | null;
    // stripeChargeId: string | null;
    createdAt: Date;
    updatedAt: Date;
}